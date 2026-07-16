import React, { useState, useEffect } from "react";
import Sidebar from "./components/Sidebar";
import DashboardView from "./components/DashboardView";
import RefineryPlaygroundView from "./components/RefineryPlaygroundView";
import ConnectorsView from "./components/ConnectorsView";
import VectorSyncView from "./components/VectorSyncView";
import AnalyticsView from "./components/AnalyticsView";
import AdminView from "./components/AdminView";
import GapsView from "./components/GapsView";
import { DocumentRecord, ActiveView } from "./types";
import { Activity, ShieldCheck, AlertCircle } from "lucide-react";
import { NotificationProvider, useNotification } from "./context/NotificationContext";
import { ToastContainer } from "./components/ToastContainer";
import { UpgradeModal } from "./components/UpgradeModal";
import { PricingPage } from "./components/PricingPage";

export default function App() {
  return (
    <NotificationProvider>
      <AppContent />
    </NotificationProvider>
  );
}

function AppContent() {
  const { toasts, removeToast, addToast } = useNotification();
  const [activeView, setActiveView] = useState<ActiveView>("dashboard");
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);
  const [stats, setStats] = useState<any>({});
  const [apiKeyLoaded, setApiKeyLoaded] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [loadingStates, setLoadingStates] = useState<{ [key: string]: boolean }>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [upgradeModal, setUpgradeModal] = useState<{
    open: boolean;
    used: number;
    limit: number;
  }>({ open: false, used: 5, limit: 5 });

  // Authentication State
  const [token, setToken] = useState<string | null>(localStorage.getItem("dhub_token"));
  const [user, setUser] = useState<any | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [tenantInput, setTenantInput] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  // Verify token, load health, docs, and stats on token change
  useEffect(() => {
    const initApp = async () => {
      if (!token) {
        setLoadingDocs(false);
        return;
      }

      try {
        setErrorMsg(null);
        // Verify current user details
        const userRes = await fetch("/api/auth/me", {
          headers: {
            "Authorization": `Bearer ${token}`
          }
        });

        if (userRes.ok) {
          const userData = await userRes.json();
          setUser(userData.user);

          // Retrieve isolated data scoped under tenant
          await Promise.all([
            checkHealth(),
            fetchDocuments(),
            fetchStats()
          ]);
        } else {
          // Token expired or invalid
          handleLogout();
        }
      } catch (err) {
        console.error("Initialization failed:", err);
        setErrorMsg("Failed to connect to the backend server. Verify the container is running.");
      } finally {
        setLoadingDocs(false);
      }
    };
    initApp();
  }, [token]);

  const handleLogout = () => {
    localStorage.removeItem("dhub_token");
    setToken(null);
    setUser(null);
    setDocuments([]);
    setStats({});
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailInput || !passwordInput) {
      addToast("error", "Validation error", "Email and password are required.");
      return;
    }

    setAuthLoading(true);
    try {
      const url = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
      const payload = authMode === "login"
        ? { email: emailInput, password: passwordInput }
        : { email: emailInput, password: passwordInput, tenantId: tenantInput || undefined };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (res.ok) {
        localStorage.setItem("dhub_token", data.token);
        setToken(data.token);
        setUser(data.user);
        addToast("success", authMode === "login" ? "Welcome Back!" : "Workspace Registered", "Session successfully authenticated.");
      } else {
        addToast("error", "Authentication Failed", data.error || "Incorrect email or password");
      }
    } catch (err) {
      console.error("Auth submit failed:", err);
      addToast("error", "Connection error", "Cannot reach authentication endpoints.");
    } finally {
      setAuthLoading(false);
    }
  };

  const checkHealth = async () => {
    try {
      const res = await fetch("/api/health");
      if (res.ok) {
        const data = await res.json();
        setApiKeyLoaded(data.apiKeyLoaded);
      }
    } catch (err) {
      console.warn("Health check failed:", err);
    }
  };

  const fetchDocuments = async () => {
    try {
      const res = await fetch("/api/documents", {
        headers: {
          "Authorization": `Bearer ${token}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        setDocuments(data);
      }
    } catch (err) {
      console.error("Fetch documents failed:", err);
      throw err;
    }
  };

  const fetchStats = async () => {
    try {
      const res = await fetch("/api/stats", {
        headers: {
          "Authorization": `Bearer ${token}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch (err) {
      console.error("Fetch stats failed:", err);
    }
  };

  const handleSelectDoc = (doc: DocumentRecord) => {
    setSelectedDoc(doc);
    setActiveView("refinery");
  };

  const handleRefineDoc = async (docId: string) => {
    setLoadingStates(prev => ({ ...prev, [docId]: true }));
    try {
      const res = await fetch(`/api/documents/${docId}/refine`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`
        }
      });
      if (res.ok) {
        await fetchDocuments();
        await fetchStats();
        addToast("success", "Document refined successfully", "The document has been processed through the refinery pipeline.");
      } else if (res.status === 402) {
        const data = await res.json();
        setUpgradeModal({
          open: true,
          used: data.quota?.refinementCount || 5,
          limit: data.quota?.refinementLimit || 5,
        });
      } else {
        const data = await res.json();
        addToast("error", "Refinement failed", data.error || "Unknown server error");
      }
    } catch (err) {
      console.error("Refining failed:", err);
      addToast("error", "Refinement error", "Network error or server unavailable");
    } finally {
      setLoadingStates(prev => ({ ...prev, [docId]: false }));
    }
  };

  const handleDeleteDoc = async (docId: string) => {
    if (!confirm("Are you sure you want to delete this document from the pipeline database?")) return;
    try {
      const res = await fetch(`/api/documents/${docId}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${token}`
        }
      });
      if (res.ok) {
        setDocuments(prev => prev.filter(d => d.id !== docId));
        if (selectedDoc && selectedDoc.id === docId) {
          setSelectedDoc(null);
        }
        await fetchStats();
        addToast("success", "Document deleted", "The document has been removed from the database.");
      } else {
        addToast("error", "Deletion failed", "Could not delete the document.");
      }
    } catch (err) {
      console.error("Deletion failed:", err);
      addToast("error", "Deletion error", "Network error");
    }
  };

  const handleUploadDoc = async (name: string, content: string, type: "PDF" | "DOCX" | "XLSX" | "TXT", connector: string) => {
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          name,
          type,
          rawContent: content,
          connector
        })
      });
      if (res.ok) {
        const newDoc = await res.json();
        setDocuments(prev => [newDoc, ...prev]);
        addToast("success", "Document uploaded", `${name} has been ingested and queued for processing.`);
        // Trigger refining automatically on creation
        await handleRefineDoc(newDoc._id || newDoc.id);
      } else {
        addToast("error", "Upload failed", "Could not upload the document.");
      }
    } catch (err) {
      console.error("Asset ingestion failed:", err);
      addToast("error", "Upload error", "Network error or file too large.");
    }
  };

  const handleQuickRefine = async (text: string, name: string): Promise<DocumentRecord> => {
    try {
      const res = await fetch("/api/refine-text", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ text, name })
      });
      if (res.ok) {
        const result = await res.json();

        const mockDoc: DocumentRecord = {
          id: `sandbox-${Date.now()}`,
          name: name || "sandbox_result.txt",
          type: "TXT",
          size: `${Math.round(text.length / 1024)} KB`,
          connector: "Local Upload",
          status: "refined",
          rawContent: text,
          parsedContent: result.parsedContent,
          cleanedContent: result.cleanedContent,
          redactedContent: result.redactedContent,
          metadata: result.metadata,
          chunks: result.chunks,
          vectorSync: {
            qdrant: { indexName: "sandbox-knowledge-base", status: "Synced", vectorsCount: result.chunks.length, dimensions: 1536, latencyMs: 14, lastSyncedAt: new Date().toISOString() },
            pinecone: { indexName: "sandbox-enterprise-index", status: "Synced", vectorsCount: result.chunks.length, dimensions: 1536, latencyMs: 24, lastSyncedAt: new Date().toISOString() }
          },
          readinessScore: result.readinessScore,
          piiFindingsCount: result.piiFindingsCount,
          piiFindings: result.piiFindings,
          duplicatesRemoved: result.duplicatesRemoved,
          createdAt: new Date().toISOString()
        };

        setDocuments(prev => [mockDoc, ...prev]);
        await fetchStats();
        addToast("success", "Quick refine complete", "Sandbox data processed successfully.");
        return mockDoc;
      } 
      
      else if (res.status === 402) {
  const data = await res.json();
  setUpgradeModal({
    open: true,
    used: data.quota?.refinementCount || 5,
    limit: data.quota?.refinementLimit || 5,
  });
  throw new Error("quota");
}
      else {
        throw new Error("Refinement failed on server");
      }
    } catch (err) {
      console.error("Quick Refine failed:", err);
      addToast("error", "Quick refine failed", "Could not process the text. Check API configuration.");
      throw err;
    }
  };

  if (!token) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0A0A0B] text-white p-4 font-sans relative overflow-hidden">
        {/* Sleek background decoration */}
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full bg-blue-600/10 blur-[120px] pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-green-600/10 blur-[120px] pointer-events-none" />

        <div className="w-full max-w-md bg-[#111113]/60 backdrop-blur-xl border border-[#27272a]/60 p-8 rounded-2xl shadow-2xl relative z-10 space-y-6">
          <div className="flex flex-col items-center space-y-3">
            <div className="w-12 h-12 rounded-xl bg-blue-600/10 border border-blue-500/30 flex items-center justify-center">
              <ShieldCheck className="w-7 h-7 text-blue-500 animate-pulse" />
            </div>
            <div className="text-center">
              <h2 className="text-xl font-semibold tracking-tight text-white font-display">Clean Data Hub</h2>
              <p className="text-xs text-gray-500 font-mono mt-1">v1.1 Enterprise Portal</p>
            </div>
          </div>

          <form onSubmit={handleAuthSubmit} className="space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] font-mono uppercase tracking-wider text-[#a1a1aa] font-medium">Email Address</label>
              <input
                type="email"
                required
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="you@company.com"
                className="w-full bg-[#18181b]/80 border border-[#27272a] rounded-lg px-3.5 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-all font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-mono uppercase tracking-wider text-[#a1a1aa] font-medium">Password</label>
              <input
                type="password"
                required
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="••••••••••••"
                className="w-full bg-[#18181b]/80 border border-[#27272a] rounded-lg px-3.5 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-all font-mono"
              />
            </div>

            {authMode === "register" && (
              <div className="space-y-1">
                <label className="text-[10px] font-mono uppercase tracking-wider text-[#a1a1aa] font-medium">Organization ID / Tenant ID (Optional)</label>
                <input
                  type="text"
                  value={tenantInput}
                  onChange={(e) => setTenantInput(e.target.value)}
                  placeholder="leave empty for auto-generated"
                  className="w-full bg-[#18181b]/80 border border-[#27272a] rounded-lg px-3.5 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-all font-mono"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={authLoading}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white rounded-lg py-2.5 text-xs font-semibold shadow-md shadow-blue-900/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2 mt-2 disabled:opacity-50"
            >
              {authLoading ? (
                <>
                  <Activity className="w-3.5 h-3.5 animate-spin" />
                  <span>Authenticating...</span>
                </>
              ) : (
                <span>{authMode === "login" ? "Sign In" : "Register Organization"}</span>
              )}
            </button>
          </form>

          <div className="flex items-center justify-center text-xs">
            <span className="text-gray-500">
              {authMode === "login" ? "Need a workspace?" : "Already have an account?"}{" "}
              <button
                onClick={() => setAuthMode(authMode === "login" ? "register" : "login")}
                className="text-blue-500 hover:text-blue-400 font-semibold underline focus:outline-none"
              >
                {authMode === "login" ? "Register organization" : "Sign in here"}
              </button>
            </span>
          </div>
        </div>
        <ToastContainer toasts={toasts} onRemove={removeToast} />
      </div>
    );
  }

  return (
    <div className="flex bg-[#0A0A0B] text-[#E4E4E7] font-sans min-h-screen">
      <Sidebar
        activeView={activeView}
        setActiveView={setActiveView}
        apiKeyLoaded={apiKeyLoaded}
        user={user}
        onLogout={handleLogout}
      />

      <main className="flex-1 overflow-y-auto h-screen p-8 bg-gradient-to-b from-[#111113] to-[#0A0A0B]">
        {errorMsg && (
          <div className="p-4 mb-6 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400" />
            <span>{errorMsg}</span>
          </div>
        )}

        {loadingDocs ? (
          <div className="flex flex-col items-center justify-center h-full space-y-3">
            <Activity className="w-8 h-8 text-green-500 animate-spin" />
            <p className="text-xs font-mono text-gray-500">Connecting to secure data hub...</p>
          </div>
        ) : (
          <>
            {activeView === "dashboard" && (
              <DashboardView
                documents={documents}
                onSelectDoc={handleSelectDoc}
                onRefineDoc={handleRefineDoc}
                onDeleteDoc={handleDeleteDoc}
                onUploadDoc={handleUploadDoc}
                stats={stats}
                loadingStates={loadingStates}
              />
            )}

            {activeView === "refinery" && (
              <RefineryPlaygroundView
                documents={documents}
                selectedDoc={selectedDoc}
                onRefineDoc={handleRefineDoc}
                onQuickRefine={handleQuickRefine}
                loadingStates={loadingStates}
              />
            )}

            {activeView === "connectors" && <ConnectorsView />}

            {activeView === "vector" && <VectorSyncView />}

            {activeView === "analytics" && <AnalyticsView stats={stats} />}

            {activeView === "admin" && <AdminView />}

            {activeView === "gaps" && <GapsView />}

            {activeView === "pricing" && <PricingPage />}
          </>
        )}

         <UpgradeModal
        isOpen={upgradeModal.open}
        onClose={() => setUpgradeModal(s => ({ ...s, open: false }))}
        usedCount={upgradeModal.used}
        limitCount={upgradeModal.limit}
        reason="quota"
      />
      
      </main>
    </div>
  );
}
