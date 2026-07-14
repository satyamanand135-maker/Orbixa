import crypto from "crypto";
import { Organization, WebhookLog } from "./server-db.ts";

/**
 * Dispatch an outbound webhook event with HMAC-SHA256 signature and retry backoff.
 */
export async function dispatchWebhook(tenantId: string, event: string, payload: any): Promise<void> {
  try {
    // Retrieve webhook configurations from tenant organization
    const org = await Organization.findOne({ tenantId });
    if (!org || !org.webhookUrl) {
      return; // Webhook not configured for this tenant
    }

    const targetUrl = org.webhookUrl;
    const secret = org.webhookSecret || "dhub-default-webhook-secret";
    
    // Prepare payload body
    const bodyString = JSON.stringify({
      event,
      tenantId,
      timestamp: new Date().toISOString(),
      data: payload,
    });

    // Compute signature using HMAC-SHA256
    const signature = crypto
      .createHmac("sha256", secret)
      .update(bodyString)
      .digest("hex");

    const maxAttempts = 3;
    let attempt = 0;
    let success = false;
    let statusCode: number | null = null;
    let responseBody = "";
    let delay = 1000; // start with 1s delay

    while (attempt < maxAttempts && !success) {
      attempt++;
      try {
        const response = await fetch(targetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-DHub-Signature": signature,
            "X-DHub-Event": event,
          },
          body: bodyString,
        });

        statusCode = response.status;
        responseBody = await response.text();

        if (response.ok) {
          success = true;
        } else {
          // Retry on server errors (5xx)
          if (response.status >= 500) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay *= 2; // exponential backoff
          } else {
            // Client error (4xx) - do not retry
            break;
          }
        }
      } catch (err: any) {
        responseBody = err.message || "Network Error";
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }

    // Log the webhook delivery in the database
    await WebhookLog.create({
      tenantId,
      event,
      url: targetUrl,
      payload,
      statusCode,
      responseBody: responseBody.slice(0, 1000), // cap long responses
      status: success ? "success" : "failed",
      attempts: attempt,
    });

    console.log(`[WEBHOOK] Dispatched event ${event} to ${targetUrl}. Status: ${success ? "SUCCESS" : "FAILED"}`);
  } catch (error) {
    console.error(`[WEBHOOK] Failed to dispatch webhook for tenant ${tenantId}:`, error);
  }
}
