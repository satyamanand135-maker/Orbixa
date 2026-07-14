/**
 * server-billing.ts — Stripe billing integration
 *
 * Endpoints:
 *   POST /api/billing/checkout      — Create Stripe Checkout Session (→ payment link)
 *   POST /api/billing/webhook       — Handle Stripe webhook events
 *   GET  /api/billing/portal        — Create Stripe Customer Portal session
 *   GET  /api/billing/plan          — Current plan info (already in server.ts, re-exported here)
 *
 * Environment variables:
 *   STRIPE_SECRET_KEY        — sk_live_… or sk_test_… (required for real billing)
 *   STRIPE_WEBHOOK_SECRET    — whsec_… (required to verify webhook signatures)
 *   STRIPE_PRICE_PRO         — Price ID for Pro plan (e.g. price_…)
 *   STRIPE_PRICE_ENTERPRISE  — Price ID for Enterprise plan
 *
 * Graceful degradation:
 *   If STRIPE_SECRET_KEY is not set, all endpoints return mock responses so that
 *   tests and development environments continue to work without a Stripe account.
 */

import express, { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAuth } from "./server-auth.ts";

const router = Router();

// ---------------------------------------------------------------------------
// Stripe lazy-loader (avoids hard dependency when key is absent)
// ---------------------------------------------------------------------------
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const PRICE_PRO = process.env.STRIPE_PRICE_PRO || "price_pro_monthly";
const PRICE_ENTERPRISE = process.env.STRIPE_PRICE_ENTERPRISE || "price_enterprise_monthly";

type StripeClient = any; // Stripe types — installed via `npm i stripe`
let _stripe: StripeClient | null = null;

async function getStripe(): Promise<StripeClient | null> {
  if (!STRIPE_KEY) return null;
  if (_stripe) return _stripe;
  try {
    const { default: Stripe } = await import("stripe" as any);
    _stripe = new Stripe(STRIPE_KEY, { apiVersion: "2024-06-20" });
    return _stripe;
  } catch {
    console.warn("[Billing] Stripe package not installed. Run: npm install stripe");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Verify Stripe webhook signature (raw body required) */
function verifyStripeSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!secret) return false;
  try {
    // Stripe signature format: t=timestamp,v1=hmac,...
    const parts = signature.split(",");
    const tPart = parts.find((p) => p.startsWith("t="));
    const v1Parts = parts.filter((p) => p.startsWith("v1="));
    if (!tPart || v1Parts.length === 0) return false;

    const timestamp = tPart.slice(2);
    const payload = `${timestamp}.${rawBody.toString("utf8")}`;

    for (const v1 of v1Parts) {
      const expected = v1.slice(3);
      const computed = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      if (crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expected))) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Get or create Stripe customer for a tenant */
async function getOrCreateStripeCustomer(stripe: StripeClient, org: any): Promise<string> {
  if (org.stripeCustomerId) return org.stripeCustomerId;

  const customer = await stripe.customers.create({
    email: org.billingEmail || `billing@${org.tenantId}.dhub.io`,
    name: org.name || org.tenantId,
    metadata: { tenantId: org.tenantId },
  });

  org.stripeCustomerId = customer.id;
  await org.save();
  return customer.id;
}

// ---------------------------------------------------------------------------
// POST /api/billing/checkout
// ---------------------------------------------------------------------------
router.post("/checkout", requireAuth, async (req: Request, res: Response) => {
  try {
    const stripe = await getStripe();
    const plan: "pro" | "enterprise" = req.body?.plan || "pro";
    const successUrl = req.body?.successUrl || `${process.env.APP_URL || "http://localhost:3000"}/billing/success`;
    const cancelUrl = req.body?.cancelUrl || `${process.env.APP_URL || "http://localhost:3000"}/billing/cancel`;

    if (!stripe) {
      // Mock response for dev/test
      return res.json({
        mock: true,
        url: `${successUrl}?session_id=mock_session_${crypto.randomUUID()}`,
        message: "Stripe not configured — returning mock checkout URL",
      });
    }

    const { Organization } = await import("./server-db.ts");
    const org = await Organization.findOne({ tenantId: req.user!.tenantId });
    if (!org) return res.status(404).json({ error: "Organization not found" });

    const customerId = await getOrCreateStripeCustomer(stripe, org);
    const priceId = plan === "enterprise" ? PRICE_ENTERPRISE : PRICE_PRO;

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      metadata: { tenantId: req.user!.tenantId, plan },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err: any) {
    console.error("[Billing] Checkout error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/billing/portal
// ---------------------------------------------------------------------------
router.get("/portal", requireAuth, async (req: Request, res: Response) => {
  try {
    const stripe = await getStripe();
    const returnUrl = req.query.returnUrl as string || `${process.env.APP_URL || "http://localhost:3000"}/billing`;

    if (!stripe) {
      return res.json({ mock: true, url: returnUrl, message: "Stripe not configured" });
    }

    const { Organization } = await import("./server-db.ts");
    const org = await Organization.findOne({ tenantId: req.user!.tenantId });
    if (!org?.stripeCustomerId) {
      return res.status(400).json({ error: "No Stripe customer found. Please subscribe first." });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: returnUrl,
    });

    res.json({ url: session.url });
  } catch (err: any) {
    console.error("[Billing] Portal error:", err);
    res.status(500).json({ error: "Failed to create billing portal session" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/billing/webhook  (raw body required — mount before express.json())
// ---------------------------------------------------------------------------
export function registerBillingWebhook(app: import("express").Express) {
  app.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json" }),
    async (req: Request, res: Response) => {
      const signature = req.headers["stripe-signature"] as string;

      if (!verifyStripeSignature(req.body as Buffer, signature, WEBHOOK_SECRET)) {
        console.warn("[Billing] Webhook signature verification failed");
        return res.status(400).json({ error: "Invalid webhook signature" });
      }

      let event: any;
      try {
        event = JSON.parse((req.body as Buffer).toString("utf8"));
      } catch {
        return res.status(400).json({ error: "Invalid JSON payload" });
      }

      try {
        const { Organization } = await import("./server-db.ts");

        switch (event.type) {
          case "customer.subscription.updated":
          case "customer.subscription.created": {
            const sub = event.data.object;
            const tenantId = sub.metadata?.tenantId;
            if (tenantId) {
              const plan = sub.metadata?.plan || "pro";
              await Organization.findOneAndUpdate(
                { tenantId },
                { plan, stripeSubscriptionId: sub.id, subscriptionStatus: sub.status }
              );
              console.log(`[Billing] Subscription updated: tenant=${tenantId} plan=${plan} status=${sub.status}`);
            }
            break;
          }

          case "customer.subscription.deleted": {
            const sub = event.data.object;
            const tenantId = sub.metadata?.tenantId;
            if (tenantId) {
              await Organization.findOneAndUpdate(
                { tenantId },
                { plan: "free", subscriptionStatus: "canceled" }
              );
              console.log(`[Billing] Subscription cancelled: tenant=${tenantId}`);
            }
            break;
          }

          case "invoice.payment_succeeded": {
            const inv = event.data.object;
            console.log(`[Billing] Invoice paid: ${inv.id} amount=${inv.amount_paid}`);
            break;
          }

          case "invoice.payment_failed": {
            const inv = event.data.object;
            const tenantId = inv.subscription_details?.metadata?.tenantId;
            console.error(`[Billing] Payment failed for tenant=${tenantId} invoice=${inv.id}`);
            // Optionally: downgrade to free, send alert email
            break;
          }

          default:
            // Acknowledge unknown events without processing
            break;
        }

        res.json({ received: true, type: event.type });
      } catch (err: any) {
        console.error("[Billing] Webhook handler error:", err);
        res.status(500).json({ error: "Webhook processing failed" });
      }
    }
  );
}

export { router as billingRouter };
