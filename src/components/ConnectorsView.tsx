import React, { useState } from "react";
import { 
  Share2, 
  Database, 
  Github, 
  FolderGit2, 
  RefreshCw, 
  CheckCircle2, 
  AlertCircle,
  Clock,
  ArrowUpRight,
  ShieldAlert,
  Settings2,
  Lock
} from "lucide-react";

interface Connector {
  id: string;
  name: string;
  type: string;
  status: "connected" | "disconnected" | "syncing";
  lastSynced: string;
  filesCount: number;
  frequency: string;
  oauthProvider?: "google-drive" | "notion" | "slack";
}

export default function ConnectorsView() {
  const [connectors, setConnectors] = useState<Connector[]>([
    { id: "gdrive", name: "Google Drive Workspace", type: "Cloud Storage", status: "connected", lastSynced: "4 hours ago", filesCount: 142, frequency: "Every 4 Hours", oauthProvider: "google-drive" },
    { id: "github", name: "GitHub Corporate Repos", type: "DevOps Wikis", status: "connected", lastSynced: "1 day ago", filesCount: 28, frequency: "Daily at 12:00 AM" },
    { id: "notion", name: "Notion Knowledge Bases", type: "Internal Wiki", status: "disconnected", lastSynced: "Never", filesCount: 0, frequency: "Manual Sync Only", oauthProvider: "notion" },
    { id: "slack", name: "Slack Workspace", type: "Collaboration", status: "disconnected", lastSynced: "Never", filesCount: 0, frequency: "Manual Sync Only", oauthProvider: "slack" },
    { id: "sharepoint", name: "SharePoint Systems", type: "Enterprise Intra", status: "connected", lastSynced: "12 hours ago", filesCount: 82, frequency: "Every 12 Hours" },
    { id: "confluence", name: "Atlassian Confluence", type: "Documentation", status: "disconnected", lastSynced: "Never", filesCount: 0, frequency: "Manual Sync Only" },
    { id: "s3", name: "AWS S3 Raw Buckets", type: "Object Storage", status: "disconnected", lastSynced: "Never", filesCount: 0, frequency: "Every 2 Hours" }
  ]);

  const [activeConfigId, setActiveConfigId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  const handleSyncNow = (id: string) => {
    setSyncingId(id);
    
    // Simulate active sync animation
    setTimeout(() => {
      setConnectors(prev => prev.map(c => {
        if (c.id === id) {
          return {
            ...c,
            status: "connected",
            lastSynced: "Just now",
            filesCount: c.filesCount + Math.floor(Math.random() * 4) + 1
          };
        }
        return c;
      }));
      setSyncingId(null);
    }, 2500);
  };

  const startOAuth = async (conn: Connector) => {
    if (!conn.oauthProvider) return false;

    const token = localStorage.getItem("dhub_token");
    if (!token) return false;

    setConnectingId(conn.id);
    try {
      const res = await fetch(`/api/connectors/oauth/${conn.oauthProvider}/start`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok || !data.authUrl) {
        throw new Error(data.error || "Failed to start OAuth");
      }
      window.location.assign(data.authUrl);
      return true;
    } catch (err) {
      console.error("Connector OAuth failed:", err);
      setConnectingId(null);
      return false;
    }
  };

  const toggleConnector = async (conn: Connector) => {
    if (conn.status !== "connected" && conn.oauthProvider) {
      await startOAuth(conn);
      return;
    }

    setConnectors(prev => prev.map(c => {
      if (c.id === conn.id) {
        return {
          ...c,
          status: c.status === "connected" ? "disconnected" : "connected",
          filesCount: c.status === "connected" ? 0 : Math.floor(Math.random() * 50) + 10,
          lastSynced: c.status === "connected" ? "Never" : "Just now"
        };
      }
      return c;
    }));
  };

  return (
    <div id="connectors-view" className="space-y-6">
      {/* Header section */}
      <div>
        <h2 className="text-xl font-display font-semibold text-white tracking-wide flex items-center gap-2">
          <Share2 className="w-5 h-5 text-[#3b82f6]" />
          Enterprise Data Connectors
        </h2>
        <p className="text-xs text-gray-400 mt-1 max-w-xl">
          Establish scheduled data syncs from secure cloud sources. Connected data automatically triggers parsing, cleaning, and redaction protocols.
        </p>
      </div>

      {/* Grid of Connectors */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {connectors.map((conn) => {
          const isConfigOpen = activeConfigId === conn.id;
          const isSyncing = syncingId === conn.id;
          
          return (
            <div 
              key={conn.id} 
              className={`bg-[#18181b] border rounded-xl overflow-hidden shadow-lg transition-all ${
                conn.status === "connected" ? "border-[#27272a] hover:border-[#3b82f6]/15" : "border-[#27272a] opacity-75"
              }`}
            >
              {/* Card top */}
              <div className="p-5 space-y-4">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <span className="text-[10px] font-mono text-zinc-500 font-semibold uppercase tracking-wider">{conn.type}</span>
                    <h3 className="text-sm font-semibold text-white tracking-tight">{conn.name}</h3>
                  </div>
                  
                  {/* Status Indicator Badge */}
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-mono font-bold ${
                    isSyncing 
                      ? "bg-blue-500/10 text-blue-400 border border-blue-500/20" 
                      : (conn.status === "connected" 
                          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" 
                          : "bg-zinc-800 text-zinc-400 border border-zinc-700")
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      isSyncing ? "bg-blue-500 animate-spin" : (conn.status === "connected" ? "bg-emerald-500 animate-pulse" : "bg-zinc-500")
                    }`}></span>
                    {isSyncing ? "Syncing" : (conn.status === "connected" ? "Connected" : "Inactive")}
                  </span>
                </div>

                {/* Info row */}
                <div className="grid grid-cols-2 gap-4 text-[10px] font-mono text-gray-400 bg-[#111113] p-3 rounded-lg border border-[#27272a]">
                  <div className="space-y-1">
                    <span className="text-gray-500 block">LAST SYNCED</span>
                    <span className="text-gray-200 font-semibold flex items-center gap-1">
                      <Clock className="w-3 h-3 text-gray-500" />
                      {conn.lastSynced}
                    </span>
                  </div>
                  <div className="space-y-1">
                    <span className="text-gray-500 block">ACTIVE RECORDS</span>
                    <span className="text-gray-200 font-semibold">{conn.filesCount} assets</span>
                  </div>
                </div>

                {/* Actions line */}
                <div className="flex items-center justify-between pt-2">
                  <button
                    onClick={() => setActiveConfigId(isConfigOpen ? null : conn.id)}
                    className="text-[11px] font-mono font-semibold text-gray-400 hover:text-white flex items-center gap-1 bg-transparent border-0 cursor-pointer"
                  >
                    <Settings2 className="w-3.5 h-3.5 text-gray-500" />
                    Configure Sync
                  </button>

                  <div className="flex gap-2">
                    {conn.status === "connected" && (
                      <button
                        disabled={isSyncing}
                        onClick={() => handleSyncNow(conn.id)}
                        className="px-2.5 py-1 bg-[#3b82f6] hover:bg-blue-600 disabled:bg-zinc-800 text-white hover:text-white text-[10px] font-bold rounded flex items-center gap-1 transition-all cursor-pointer border-0"
                      >
                        <RefreshCw className={`w-3 h-3 ${isSyncing ? "animate-spin" : ""}`} />
                        Sync Now
                      </button>
                    )}
                    <button
                      disabled={connectingId === conn.id}
                      onClick={() => toggleConnector(conn)}
                      className={`px-2.5 py-1 text-[10px] font-bold rounded transition-colors cursor-pointer border ${
                        conn.status === "connected" 
                          ? "bg-transparent hover:bg-red-500/10 text-red-400 border-red-500/10" 
                          : "bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border-transparent"
                      }`}
                    >
                      {connectingId === conn.id ? "Connecting" : (conn.status === "connected" ? "Disconnect" : "Connect")}
                    </button>
                  </div>
                </div>
              </div>

              {/* Collapsible config panel */}
              {isConfigOpen && (
                <div className="border-t border-[#27272a] bg-[#111113] p-5 space-y-4 animate-slide-down">
                  <div className="flex items-center gap-1.5 text-amber-500 text-[10px] font-mono font-bold bg-amber-500/5 p-2 rounded border border-amber-500/10">
                    <Lock className="w-3.5 h-3.5" />
                    APPLICATIONS CREDENTIAL SHIELDED BY KMS
                  </div>
                  
                  <div className="space-y-3">
                    <div>
                      <label className="block text-[9px] font-mono font-bold text-zinc-500 uppercase mb-1">OAuth Token / Client secret</label>
                      <input 
                        type="password" 
                        disabled={conn.status !== "connected"}
                        value={conn.status === "connected" ? "••••••••••••••••••••••••" : ""}
                        placeholder="Not connected — input API credential"
                        className="w-full bg-[#18181b] border border-[#27272a] rounded px-2.5 py-1.5 font-mono text-xs text-white focus:outline-none focus:border-[#3b82f6]" 
                      />
                    </div>
                    <div>
                      <label className="block text-[9px] font-mono font-bold text-zinc-500 uppercase mb-1">Target Directory Scope</label>
                      <input 
                        type="text" 
                        disabled={conn.status !== "connected"}
                        placeholder={conn.status === "connected" ? "/acme-secure-rag-files/" : "/root/"}
                        className="w-full bg-[#18181b] border border-[#27272a] rounded px-2.5 py-1.5 font-mono text-xs text-white focus:outline-none focus:border-[#3b82f6]" 
                      />
                    </div>
                    <div>
                      <label className="block text-[9px] font-mono font-bold text-zinc-500 uppercase mb-1">Auto Refresh Schedule</label>
                      <select 
                        disabled={conn.status !== "connected"}
                        value={conn.frequency}
                        onChange={() => {}}
                        className="w-full bg-[#18181b] border border-[#27272a] rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#3b82f6]"
                      >
                        <option value="Every 2 Hours">Every 2 Hours</option>
                        <option value="Every 4 Hours">Every 4 Hours</option>
                        <option value="Every 12 Hours">Every 12 Hours</option>
                        <option value="Daily scheduled sync active">Daily at midnight</option>
                        <option value="Manual Sync Only">Manual Sync Only</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
