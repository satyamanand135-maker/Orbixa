// src/components/UpgradeModal.tsx
// Shows automatically when user hits the 5-refinement free plan limit
// or when any API call returns a 402 quota error.

import { useState } from "react";

interface Plan {
  id: "starter" | "pro" | "business";
  name: string;
  price: string;
  docs: string;
  features: string[];
  highlight: boolean;
  badge?: string;
}

const PLANS: Plan[] = [
  {
    id: "starter",
    name: "Starter",
    price: "$99",
    docs: "100 docs/month",
    highlight: false,
    features: [
      "100 documents/month",
      "Layout-aware PDF parsing",
      "PII detection & masking",
      "1 vector DB sync",
      "2 connectors",
      "Email support",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$299",
    docs: "1,000 docs/month",
    highlight: true,
    badge: "Most Popular",
    features: [
      "1,000 documents/month",
      "All parsing formats",
      "Multi-language PII",
      "5 vector DB syncs",
      "All 8 connectors",
      "Priority support",
      "Analytics dashboard",
    ],
  },
  {
    id: "business",
    name: "Business",
    price: "$999",
    docs: "10,000 docs/month",
    highlight: false,
    features: [
      "10,000 documents/month",
      "Everything in Pro",
      "SAML SSO",
      "Custom chunking modes",
      "Audit logs",
      "GDPR & HIPAA tools",
      "Dedicated support",
      "SLA guarantee",
    ],
  },
];

interface UpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  usedCount?: number;
  limitCount?: number;
  reason?: "quota" | "storage" | "feature";
}

export function UpgradeModal({
  isOpen,
  onClose,
  usedCount = 5,
  limitCount = 5,
  reason = "quota",
}: UpgradeModalProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const reasonText = {
    quota: `You've used all ${limitCount} free refinements.`,
    storage: "You've reached your free storage limit.",
    feature: "This feature requires a paid plan.",
  }[reason];

  async function handleUpgrade(planId: "starter" | "pro" | "business") {
    setLoading(planId);
    setError(null);
    try {
      const token = localStorage.getItem("dhub_token");
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          plan: planId,
          successUrl: `${window.location.origin}/?upgraded=true`,
          cancelUrl: window.location.href,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to start checkout");
      }

      if (data.mock) {
        alert("Paddle not configured yet. In production this would redirect to payment.");
        return;
      }

      // Redirect to Paddle checkout
      window.location.href = data.url;
    } catch (err: any) {
      setError(err.message);
      setLoading(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.75)" }}
    >
      <div
        className="relative w-full max-w-4xl rounded-2xl border border-gray-700 shadow-2xl overflow-hidden"
        style={{ backgroundColor: "#0f0f1a" }}
      >
        {/* Header */}
        <div className="p-6 pb-0 text-center">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>

          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-4"
            style={{ backgroundColor: "#1e1e3a" }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </div>

          <h2 className="text-2xl font-bold text-white mb-2">
            Upgrade Clean Data Hub
          </h2>
          <p className="text-gray-400 text-sm mb-1">{reasonText}</p>
          <p className="text-gray-500 text-sm mb-6">
            Choose a plan to continue processing documents.
          </p>

          {/* Usage bar */}
          {reason === "quota" && (
            <div className="max-w-xs mx-auto mb-6">
              <div className="flex justify-between text-xs text-gray-400 mb-1">
                <span>Free refinements used</span>
                <span>{usedCount}/{limitCount}</span>
              </div>
              <div className="h-2 rounded-full" style={{ backgroundColor: "#1e1e3a" }}>
                <div
                  className="h-2 rounded-full"
                  style={{
                    width: `${Math.min(100, (usedCount / limitCount) * 100)}%`,
                    backgroundColor: "#ef4444",
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Plan cards */}
        <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          {PLANS.map((plan) => (
            <div
              key={plan.id}
              className="relative rounded-xl p-5 border flex flex-col"
              style={{
                backgroundColor: plan.highlight ? "#1a1a3e" : "#13131f",
                borderColor: plan.highlight ? "#6366f1" : "#2a2a3a",
              }}
            >
              {plan.badge && (
                <div
                  className="absolute -top-3 left-1/2 -translate-x-1/2 text-xs font-semibold px-3 py-1 rounded-full"
                  style={{ backgroundColor: "#6366f1", color: "white" }}
                >
                  {plan.badge}
                </div>
              )}

              <div className="mb-4">
                <p className="text-gray-400 text-sm font-medium mb-1">{plan.name}</p>
                <div className="flex items-end gap-1">
                  <span className="text-3xl font-bold text-white">{plan.price}</span>
                  <span className="text-gray-400 text-sm mb-1">/month</span>
                </div>
                <p className="text-gray-500 text-xs mt-1">{plan.docs}</p>
              </div>

              <ul className="flex-1 space-y-2 mb-5">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-gray-300">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5">
                      <polyline points="20,6 9,17 4,12" />
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>

              <button
                onClick={() => handleUpgrade(plan.id)}
                disabled={loading !== null}
                className="w-full py-2.5 rounded-lg text-sm font-semibold transition-all"
                style={{
                  backgroundColor: plan.highlight ? "#6366f1" : "#1e1e3a",
                  color: "white",
                  border: plan.highlight ? "none" : "1px solid #2a2a3a",
                  opacity: loading !== null ? 0.6 : 1,
                  cursor: loading !== null ? "not-allowed" : "pointer",
                }}
              >
                {loading === plan.id ? "Redirecting..." : `Get ${plan.name}`}
              </button>
            </div>
          ))}
        </div>

        {error && (
          <p className="text-center text-red-400 text-sm pb-4">{error}</p>
        )}

        <p className="text-center text-gray-600 text-xs pb-4">
          Secure payment via Paddle | Cancel anytime | No hidden fees
        </p>
      </div>
    </div>
  );
}

// Hook to use anywhere in your app
// Usage: const { showUpgrade, UpgradeGate } = useUpgradeGate()
export function useUpgradeGate() {
  const [upgradeState, setUpgradeState] = useState<{
    open: boolean;
    reason: "quota" | "storage" | "feature";
    used: number;
    limit: number;
  }>({ open: false, reason: "quota", used: 5, limit: 5 });

  function showUpgrade(reason: "quota" | "storage" | "feature" = "quota", used = 5, limit = 5) {
    setUpgradeState({ open: true, reason, used, limit });
  }

  function hideUpgrade() {
    setUpgradeState((s) => ({ ...s, open: false }));
  }

  // Call this on every API response - it auto-detects 402 errors
  async function guardedFetch(url: string, options?: RequestInit) {
    const token = localStorage.getItem("dhub_token");
    const res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options?.headers || {}),
      },
    });

    if (res.status === 402) {
      const data = await res.json();
      showUpgrade(
        "quota",
        data.quota?.refinementCount || 5,
        data.quota?.refinementLimit || 5
      );
      return null; // Signal to caller that request was blocked
    }

    return res;
  }

  return {
    showUpgrade,
    guardedFetch,
    UpgradeGate: (
      <UpgradeModal
        isOpen={upgradeState.open}
        onClose={hideUpgrade}
        usedCount={upgradeState.used}
        limitCount={upgradeState.limit}
        reason={upgradeState.reason}
      />
    ),
  };
}
