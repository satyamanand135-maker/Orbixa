// src/components/PricingPage.tsx
// Standalone pricing page at /pricing route
// Shows 3 plans, handles Paddle checkout redirect

import { useState } from "react";

const PLANS = [
  {
    id: "starter" as const,
    name: "Starter",
    price: 99,
    period: "month",
    docs: "100",
    storage: "5 GB",
    description: "Perfect for solo developers and small projects.",
    color: "#3b82f6",
    features: [
      "100 documents/month",
      "PDF, DOCX, XLSX, PPTX parsing",
      "Layout-aware table extraction",
      "PII detection & masking",
      "1 vector DB sync (Qdrant or Chroma)",
      "2 connectors (Google Drive + GitHub)",
      "AI Readiness Score",
      "Email support",
    ],
    missing: [
      "SAML SSO",
      "Multi-language PII",
      "Audit logs",
    ],
  },
  {
    id: "pro" as const,
    name: "Pro",
    price: 299,
    period: "month",
    docs: "1,000",
    storage: "50 GB",
    description: "For growing teams building production RAG systems.",
    color: "#6366f1",
    popular: true,
    features: [
      "1,000 documents/month",
      "Everything in Starter",
      "OCR for scanned PDFs",
      "Multi-language PII (13 languages)",
      "All 5 vector DB adapters",
      "All 8 connectors",
      "Semantic & table-aware chunking",
      "Analytics dashboard",
      "Webhook events",
      "Priority email support",
    ],
    missing: [
      "SAML SSO",
      "Custom SLA",
    ],
  },
  {
    id: "business" as const,
    name: "Business",
    price: 999,
    period: "month",
    docs: "10,000",
    storage: "500 GB",
    description: "Enterprise-grade for large teams and compliance-sensitive industries.",
    color: "#8b5cf6",
    features: [
      "10,000 documents/month",
      "Everything in Pro",
      "SAML / OIDC SSO",
      "RBAC & audit logs",
      "GDPR right-to-erasure API",
      "HIPAA PHI logging",
      "IP allowlisting",
      "Custom data retention policies",
      "Dedicated Slack support",
      "99.9% uptime SLA",
    ],
    missing: [],
  },
];

export function PricingPage() {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [annual, setAnnual] = useState(false);

  async function handleCheckout(planId: "starter" | "pro" | "business") {
    setLoading(planId);
    setError(null);
    try {
      const token = localStorage.getItem("dhub_token");

      if (!token) {
        // Not logged in - redirect to register first
        window.location.href = `/?redirect=/pricing&plan=${planId}`;
        return;
      }

      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          plan: planId,
          successUrl: `${window.location.origin}/?upgraded=true&plan=${planId}`,
          cancelUrl: window.location.href,
        }),
      });

      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Checkout failed");
      if (data.mock) {
        alert("Paddle not configured. In production this opens the Paddle checkout page.");
        setLoading(null);
        return;
      }

      window.location.href = data.url;
    } catch (err: any) {
      setError(err.message);
      setLoading(null);
    }
  }

  function getPrice(base: number) {
    return annual ? Math.round(base * 0.8) : base;
  }

  return (
    <div
      className="min-h-screen py-16 px-4"
      style={{ backgroundColor: "#0a0a14", color: "white" }}
    >
      {/* Header */}
      <div className="max-w-5xl mx-auto text-center mb-12">
        <div
          className="inline-block text-xs font-semibold px-3 py-1 rounded-full mb-4"
          style={{ backgroundColor: "#1a1a3e", color: "#818cf8" }}
        >
          Simple, transparent pricing
        </div>
        <h1 className="text-4xl font-bold mb-4">
          Power your AI with{" "}
          <span style={{ color: "#6366f1" }}>clean data</span>
        </h1>
        <p className="text-gray-400 text-lg max-w-xl mx-auto">
          Every plan includes layout-aware parsing, PII detection, and vector sync.
          No hidden fees. Cancel anytime.
        </p>

        {/* Annual toggle */}
        <div className="flex items-center justify-center gap-3 mt-8">
          <span className={`text-sm ${!annual ? "text-white" : "text-gray-500"}`}>
            Monthly
          </span>
          <button
            onClick={() => setAnnual(!annual)}
            className="relative w-12 h-6 rounded-full transition-colors"
            style={{ backgroundColor: annual ? "#6366f1" : "#2a2a3a" }}
          >
            <span
              className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform"
              style={{ transform: annual ? "translateX(24px)" : "translateX(0)" }}
            />
          </button>
          <span className={`text-sm ${annual ? "text-white" : "text-gray-500"}`}>
            Annual
            <span
              className="ml-2 text-xs px-2 py-0.5 rounded-full"
              style={{ backgroundColor: "#15803d", color: "white" }}
            >
              Save 20%
            </span>
          </span>
        </div>
      </div>

      {/* Plan cards */}
      <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
        {PLANS.map((plan) => (
          <div
            key={plan.id}
            className="relative rounded-2xl p-6 flex flex-col border"
            style={{
              backgroundColor: plan.popular ? "#13132a" : "#0f0f1a",
              borderColor: plan.popular ? "#6366f1" : "#1e1e3a",
              boxShadow: plan.popular ? "0 0 40px rgba(99,102,241,0.15)" : "none",
            }}
          >
            {plan.popular && (
              <div
                className="absolute -top-3.5 left-1/2 -translate-x-1/2 text-xs font-bold px-4 py-1 rounded-full"
                style={{ backgroundColor: "#6366f1", color: "white" }}
              >
                Most Popular
              </div>
            )}

            {/* Plan header */}
            <div className="mb-6">
              <div
                className="inline-block text-xs font-semibold px-2.5 py-1 rounded-md mb-3"
                style={{ backgroundColor: `${plan.color}20`, color: plan.color }}
              >
                {plan.name}
              </div>
              <div className="flex items-end gap-1 mb-1">
                <span className="text-4xl font-bold">${getPrice(plan.price)}</span>
                <span className="text-gray-400 text-sm mb-1.5">/{plan.period}</span>
              </div>
              {annual && (
                <p className="text-xs text-gray-500">
                  Billed annually (${getPrice(plan.price) * 12}/year)
                </p>
              )}
              <p className="text-gray-400 text-sm mt-3">{plan.description}</p>
              <div className="flex gap-4 mt-3">
                <span className="text-xs text-gray-500">
                  {plan.docs} docs/month
                </span>
                <span className="text-xs text-gray-500">
                  💾 {plan.storage} storage
                </span>
              </div>
            </div>

            {/* CTA Button */}
            <button
              onClick={() => handleCheckout(plan.id)}
              disabled={loading !== null}
              className="w-full py-3 rounded-xl text-sm font-semibold transition-all mb-6"
              style={{
                backgroundColor: plan.popular ? "#6366f1" : "transparent",
                color: "white",
                border: plan.popular ? "none" : `1px solid ${plan.color}`,
                opacity: loading !== null ? 0.6 : 1,
                cursor: loading !== null ? "not-allowed" : "pointer",
              }}
            >
              {loading === plan.id
                ? "Redirecting to checkout..."
                : `Get ${plan.name}`}
            </button>

            {/* Features */}
            <div className="flex-1">
              <p className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-3">
                Includes
              </p>
              <ul className="space-y-2.5">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-gray-300">
                    <svg
                      className="flex-shrink-0 mt-0.5"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#22c55e"
                      strokeWidth="2.5"
                    >
                      <polyline points="20,6 9,17 4,12" />
                    </svg>
                    {f}
                  </li>
                ))}
                {plan.missing.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-gray-600">
                    <svg
                      className="flex-shrink-0 mt-0.5"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>

      {/* Enterprise CTA */}
      <div
        className="max-w-5xl mx-auto rounded-2xl p-8 text-center border"
        style={{ backgroundColor: "#0f0f1a", borderColor: "#1e1e3a" }}
      >
        <h3 className="text-xl font-bold mb-2">Need more? Talk to us.</h3>
        <p className="text-gray-400 text-sm mb-4">
          Custom document limits | Private cloud / on-premise | Dedicated support | Custom SLAs
        </p>
        <a
          href="mailto:sales@orbixa.ai"
          className="inline-block px-6 py-2.5 rounded-lg text-sm font-semibold border border-indigo-500 text-indigo-400 hover:bg-indigo-500 hover:text-white transition-all"
        >
          Contact Sales &gt;
        </a>
      </div>

      {error && (
        <p className="text-center text-red-400 text-sm mt-6">{error}</p>
      )}

      {/* Trust signals */}
      <div className="max-w-5xl mx-auto mt-10 text-center">
        <p className="text-gray-600 text-sm">
          Secure payments via Paddle | Works globally including India |
          Cancel anytime | No hidden fees
        </p>
      </div>
    </div>
  );
}
