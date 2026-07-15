/**
 * server-billing.ts — Paddle billing integration for Orbixa
 *
 * Endpoints:
 *   POST /api/billing/checkout      — Create Paddle checkout URL
 *   POST /api/billing/webhook       — Handle Paddle webhook events
 *   GET  /api/billing/portal        — Redirect to Paddle customer portal
 *   GET  /api/billing/plan          — Current plan info for tenant
 *
 * Environment variables (add these to Railway):
 *   PADDLE_API_KEY                  — Your Paddle API key
 *   PADDLE_WEBHOOK_SECRET           — Your Paddle webhook secret
 *   PADDLE_STARTER_PRICE_ID         — pri_01kxjk8vc7s284vm5khsjtr5ja
 *   PADDLE_PRO_PRICE_ID             — pri_01kxjkk4jhssnstk25bjs83mpj
 *   PADDLE_BUSINESS_PRICE_ID        — pri_01kxjkndtt18tv99bw6f6der6x
 *
 * Graceful degradation:
 *   If PADDLE_API_KEY is not set, all endpoints return mock responses so
 *   development and tests work without a Paddle account.
 */

import express, { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAuth } from "./server-auth.ts";

const router = Router();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PADDLE_API_KEY       = process.env.PADDLE_API_KEY || "";
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || "";
const PADDLE_API_BASE      = "https://api.paddle.com"; // use https://sandbox-api.paddle.com for testing

const PRICE_IDS: Record<string, string> = {
  starter:  process.env.PADDLE_STARTER_PRICE_ID  || "pri_01kxjk8vc7s284vm5khsjtr5ja",
  pro:      process.env.PADDLE_PRO_PRICE_ID       || "pri_01kxjkk4jhssnstk25bjs83mpj",
  business: process.env.PADDLE_BUSINESS_PRICE_ID  || "pri_01kxjkndtt18tv99bw6f6der6x",
};

const PLAN_LIMITS: Record<string, number> = {
  free:     10,
  starter:  100,
  pro:      1000,
  business: 10000,
};

// ---------------------------------------------------------------------------
// Paddle API helper
// ---------------------------------------------------------------------------
async function paddleRequest(
  method: string,
  path: string,
  body?: object
): Promise<any> {
  if (!PADDLE_API_KEY) return null;

  const res = await fetch(`${PADDLE_API_BASE}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${PADDLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Paddle API error: ${JSON.stringify(data)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------
function verifyPaddleSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string
): boolean {
  if (!secret || !signatureHeader) return false;
  try {
    // Paddle signature format: ts=timestamp;h1=hmac
    const parts: Record<string, string> = {};
    signatureHeader.split(";").forEach((part) => {
      const [key, val] = part.split("=");
      parts[key] = val;
    });

    const timestamp = parts["ts"];
    const signature = parts["h1"];
    if (!timestamp || !signature) return false;

    const payload = `${timestamp}:${rawBody.toString("utf8")}`;
    const computed = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(computed),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Get or create Paddle customer
// ---------------------------------------------------------------------------
async function getOrCreatePaddleCustomer(org: any): Promise<string | null> {
  if (!PADDLE_API_KEY) return null;

  // Return existing customer ID if we have it
  if (org.paddleCustomerId) return org.paddleCustomerId;

  // Create new customer in Paddle
  const data = await paddleRequest("POST", "/customers", {
    email: org.billingEmail || `billing@${org.tenantId}.orbixa.io`,
    name:  org.name || org.tenantId,
  });

  const customerId = data?.data?.id;
  if (customerId) {
    org.paddleCustomerId = customerId;
    await org.save();
  }

  return customerId || null;
}

// ---------------------------------------------------------------------------
// POST /api/billing/checkout
// Creates a Paddle checkout transaction and returns the checkout URL
// ---------------------------------------------------------------------------
router.post("/checkout", requireAuth, async (req: Request, res: Response) => {
  try {
    const plan: "starter" | "pro" | "business" = req.body?.plan || "starter";
    const successUrl =
      req.body?.successUrl ||
      `${process.env.APP_URL || "http://localhost:3000"}/billing/success`;

    const priceId = PRICE_IDS[plan];
    if (!priceId) {
      return res.status(400).json({ error: `Unknown plan: ${plan}` });
    }

    // Mock response if Paddle not configured
    if (!PADDLE_API_KEY) {
      return res.json({
        mock: true,
        url: `${successUrl}?mock=true&plan=${plan}`,
        message: "Paddle not configured — returning mock checkout URL",
      });
    }

    const { Organization } = await import("./server-db.ts");
    const org = await Organization.findOne({ tenantId: req.user!.tenantId });
    if (!org) return res.status(404).json({ error: "Organization not found" });

    const customerId = await getOrCreatePaddleCustomer(org);

    // Create Paddle transaction (checkout)
    const data = await paddleRequest("POST", "/transactions", {
      items: [{ price_id: priceId, quantity: 1 }],
      customer_id: customerId,
      checkout: {
        url: successUrl,
      },
      custom_data: {
        tenantId: req.user!.tenantId,
        plan,
      },
    });

    const checkoutUrl = data?.data?.checkout?.url;
    if (!checkoutUrl) {
      throw new Error("No checkout URL returned from Paddle");
    }

    res.json({
      url: checkoutUrl,
      transactionId: data?.data?.id,
    });
  } catch (err: any) {
    console.error("[Billing] Checkout error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/billing/portal
// Redirects user to Paddle's customer portal to manage subscription
// ---------------------------------------------------------------------------
router.get("/portal", requireAuth, async (req: Request, res: Response) => {
  try {
    const returnUrl =
      (req.query.returnUrl as string) ||
      `${process.env.APP_URL || "http://localhost:3000"}/billing`;

    if (!PADDLE_API_KEY) {
      return res.json({ mock: true, url: returnUrl, message: "Paddle not configured" });
    }

    const { Organization } = await import("./server-db.ts");
    const org = await Organization.findOne({ tenantId: req.user!.tenantId });

    if (!org?.paddleCustomerId) {
      return res.status(400).json({
        error: "No Paddle customer found. Please subscribe first.",
      });
    }

    // Create customer portal session
    const data = await paddleRequest(
      "POST",
      `/customers/${org.paddleCustomerId}/portal-sessions`,
      { urls: { general: { overview: returnUrl } } }
    );

    const portalUrl = data?.data?.urls?.general?.overview;
    res.json({ url: portalUrl || returnUrl });
  } catch (err: any) {
    console.error("[Billing] Portal error:", err);
    res.status(500).json({ error: "Failed to create billing portal session" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/billing/plan
// Returns current plan info for the authenticated tenant
// ---------------------------------------------------------------------------
router.get("/plan", requireAuth, async (req: Request, res: Response) => {
  try {
    const { Organization } = await import("./server-db.ts");
    const org = await Organization.findOne({ tenantId: req.user!.tenantId });

    const plan = org?.plan || "free";
    const limit = PLAN_LIMITS[plan] || 10;

    res.json({
      plan,
      limit,
      used: org?.refinementCount || 0,
      remaining: Math.max(0, limit - (org?.refinementCount || 0)),
      subscriptionStatus: org?.subscriptionStatus || "inactive",
      paddleCustomerId: org?.paddleCustomerId || null,
      plans: [
        { id: "starter",  name: "Starter",  price: "$99/month",  docs: 100 },
        { id: "pro",      name: "Pro",       price: "$299/month", docs: 1000 },
        { id: "business", name: "Business",  price: "$999/month", docs: 10000 },
      ],
    });
  } catch (err: any) {
    console.error("[Billing] Plan error:", err);
    res.status(500).json({ error: "Failed to get plan info" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/billing/webhook
// Handles Paddle webhook events — mounted before express.json() for raw body
// ---------------------------------------------------------------------------
export function registerBillingWebhook(app: import("express").Express) {
  app.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json" }),
    async (req: Request, res: Response) => {
      const signatureHeader = req.headers["paddle-signature"] as string;

      // Verify webhook signature
      if (
        PADDLE_WEBHOOK_SECRET &&
        !verifyPaddleSignature(req.body as Buffer, signatureHeader, PADDLE_WEBHOOK_SECRET)
      ) {
        console.warn("[Billing] Webhook signature verification failed");
        return res.status(400).json({ error: "Invalid webhook signature" });
      }

      let event: any;
      try {
        event = JSON.parse((req.body as Buffer).toString("utf8"));
      } catch {
        return res.status(400).json({ error: "Invalid JSON payload" });
      }

      console.log(`[Billing] Webhook received: ${event.event_type}`);

      try {
        const { Organization } = await import("./server-db.ts");

        switch (event.event_type) {

          // Subscription activated or renewed
          case "subscription.created":
          case "subscription.activated": {
            const sub = event.data;
            const tenantId = sub.custom_data?.tenantId;
            const plan = sub.custom_data?.plan || "starter";

            if (tenantId) {
              await Organization.findOneAndUpdate(
                { tenantId },
                {
                  plan,
                  paddleSubscriptionId: sub.id,
                  paddleCustomerId: sub.customer_id,
                  subscriptionStatus: "active",
                  refinementCount: 0, // reset usage on new subscription
                }
              );
              console.log(`[Billing] Subscription activated: tenant=${tenantId} plan=${plan}`);
            }
            break;
          }

          // Subscription updated (upgrade/downgrade)
          case "subscription.updated": {
            const sub = event.data;
            const tenantId = sub.custom_data?.tenantId;
            const plan = sub.custom_data?.plan || "starter";

            if (tenantId) {
              await Organization.findOneAndUpdate(
                { tenantId },
                {
                  plan,
                  subscriptionStatus: sub.status,
                }
              );
              console.log(`[Billing] Subscription updated: tenant=${tenantId} plan=${plan} status=${sub.status}`);
            }
            break;
          }

          // Subscription cancelled
          case "subscription.canceled": {
            const sub = event.data;
            const tenantId = sub.custom_data?.tenantId;

            if (tenantId) {
              await Organization.findOneAndUpdate(
                { tenantId },
                {
                  plan: "free",
                  subscriptionStatus: "canceled",
                }
              );
              console.log(`[Billing] Subscription cancelled: tenant=${tenantId}`);
            }
            break;
          }

          // Payment completed successfully
          case "transaction.completed": {
            const tx = event.data;
            const tenantId = tx.custom_data?.tenantId;
            console.log(`[Billing] Payment completed: tenant=${tenantId} amount=${tx.details?.totals?.total}`);
            break;
          }

          // Payment failed
          case "transaction.payment_failed": {
            const tx = event.data;
            const tenantId = tx.custom_data?.tenantId;
            console.error(`[Billing] Payment failed: tenant=${tenantId}`);
            // Optionally downgrade to free or send alert
            break;
          }

          default:
            // Acknowledge all other events without processing
            break;
        }

        res.json({ received: true, type: event.event_type });
      } catch (err: any) {
        console.error("[Billing] Webhook handler error:", err);
        res.status(500).json({ error: "Webhook processing failed" });
      }
    }
  );
}

export { router as billingRouter };