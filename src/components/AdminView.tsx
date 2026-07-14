import React, { useState, useEffect } from "react";
import { 
  Shield, 
  Cpu, 
  Globe, 
  RefreshCw, 
  CheckCircle, 
  XCircle, 
  Save, 
  FileText, 
  Activity, 
  DollarSign, 
  Key, 
  Clock 
} from "lucide-react";
import { useNotification } from "../context/NotificationContext";

interface QueueStats {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

interface WorkerStats {
  name: string;
  status: string;
  queue: string;
  jobsProcessed: number;
}

interface WebhookLogEntry {
  _id: string;
  event: string;
  url: string;
  statusCode: number;
  status: string;
  attempts: number;
  timestamp: string;
  responseBody?: string;
}

export default function AdminView() {
  const { addToast } = useNotification();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Settings state
  const [ipInput, setIpInput] = useState("");
  const [retentionDays, setRetentionDays] = useState(0);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [chunkingOverlap, setChunkingOverlap] = useState(15);
  const [chunkingStrategy, setChunkingStrategy] = useState("paragraph");
  const [locale, setLocale] = useState("en");

  // System stats state
  const [queues, setQueues] = useState<{ refine: QueueStats; embedding: QueueStats } | null>(null);
  const [workers, setWorkers] = useState<WorkerStats[]>([]);
  const [webhookLogs, setWebhookLogs] = useState<WebhookLogEntry[]>([]);
  
  // Simulated Billing metrics (aggregated from documents counts)
  const [billingStats, setBillingStats] = useState({
    totalDocs: 0,
    totalTokens: 0,
    estimatedCost: 0,
  });

  const token = localStorage.getItem("dhub_token");

  const fetchData = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      // 1. Fetch settings
      const settingsRes = await fetch("/api/admin/settings", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setIpInput(data.ipAllowlist.join(", "));
        setRetentionDays(data.retentionDays);
        setWebhookUrl(data.webhookUrl);
        setWebhookSecret(data.webhookSecret);
        setChunkingOverlap(data.chunkingOverlap ?? 15);
        setChunkingStrategy(data.chunkingStrategy || "paragraph");
        setLocale(data.locale || "en");
      }

      // 2. Fetch queue stats
      const queuesRes = await fetch("/api/admin/queues", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (queuesRes.ok) {
        const data = await queuesRes.json();
        setQueues(data.queues);
        setWorkers(data.workers);
      }

      // 3. Fetch webhook logs
      const logsRes = await fetch("/api/admin/webhooks/logs", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (logsRes.ok) {
        const data = await logsRes.json();
        setWebhookLogs(data);
      }

      // 4. Fetch documents to aggregate cost metrics
      const docsRes = await fetch("/api/documents", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (docsRes.ok) {
        const docs = await docsRes.json();
        const totalDocs = docs.length;
        const totalTokens = docs.reduce((acc: number, d: any) => acc + (d.tokenCount || 0), 0);
        const estimatedCost = docs.reduce((acc: number, d: any) => acc + (d.embeddingCost || 0), 0);
        setBillingStats({ totalDocs, totalTokens, estimatedCost });
      }

    } catch (err) {
      console.error("Admin view data load failed:", err);
      addToast("error", "Failed to reload", "Could not query admin dashboard endpoints.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const ipList = ipInput
        .split(",")
        .map(ip => ip.trim())
        .filter(ip => ip.length > 0);

      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          ipAllowlist: ipList,
          retentionDays: Number(retentionDays),
          webhookUrl,
          webhookSecret,
          chunkingOverlap: Number(chunkingOverlap),
          chunkingStrategy,
          locale
        })
      });

      if (res.ok) {
        addToast("success", "Settings Saved", "Tenant policies and webhook targets updated.");
        fetchData(true);
      } else {
        const errData = await res.json();
        addToast("error", "Save Failed", errData.error || "Server rejected policies update.");
      }
    } catch (err) {
      addToast("error", "Save Error", "Connection failed saving rules.");
    } finally {
      setSaving(false);
    }
  };

  const triggerRefresh = () => {
    setRefreshing(true);
    fetchData(true);
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-96 space-y-3">
        <Activity className="w-8 h-8 text-blue-500 animate-spin" />
        <p className="text-xs font-mono text-gray-500">Loading admin operations panel...</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      {/* Title Header */}
      <div className="flex items-center justify-between border-b border-[#27272a]/60 pb-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-white font-display">System Administration</h2>
          <p className="text-xs text-gray-500 font-mono mt-1">Tenant Organization Controls & Workers Monitoring</p>
        </div>
        <button
          onClick={triggerRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#18181b] border border-[#27272a] hover:border-gray-500 rounded-lg text-xs font-medium text-white transition-all active:scale-95 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
          <span>Sync Realtime</span>
        </button>
      </div>

      {/* Grid: 4 Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-[#111113]/60 backdrop-blur-md border border-[#27272a]/60 rounded-xl p-5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-gray-500">Total Refined</span>
            <FileText className="w-4 h-4 text-blue-400" />
          </div>
          <p className="text-2xl font-semibold text-white">{billingStats.totalDocs}</p>
          <p className="text-[10px] text-gray-500 font-mono">Scoped under this tenant</p>
        </div>

        <div className="bg-[#111113]/60 backdrop-blur-md border border-[#27272a]/60 rounded-xl p-5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-gray-500">Embed Tokens</span>
            <Key className="w-4 h-4 text-green-400" />
          </div>
          <p className="text-2xl font-semibold text-white">
            {billingStats.totalTokens.toLocaleString()}
          </p>
          <p className="text-[10px] text-gray-500 font-mono">Gemini embedding input</p>
        </div>

        <div className="bg-[#111113]/60 backdrop-blur-md border border-[#27272a]/60 rounded-xl p-5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-gray-500">Estimated Cost</span>
            <DollarSign className="w-4 h-4 text-yellow-400" />
          </div>
          <p className="text-2xl font-semibold text-white">
            ${billingStats.estimatedCost.toFixed(5)}
          </p>
          <p className="text-[10px] text-gray-500 font-mono">$0.00002 / 1k standard token rate</p>
        </div>

        <div className="bg-[#111113]/60 backdrop-blur-md border border-[#27272a]/60 rounded-xl p-5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-gray-500">Worker Status</span>
            <Activity className="w-4 h-4 text-emerald-400" />
          </div>
          <p className="text-2xl font-semibold text-emerald-400">ACTIVE</p>
          <p className="text-[10px] text-gray-500 font-mono">2 Active node process daemons</p>
        </div>
      </div>

      {/* Grid: Settings and Queues */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Settings Column */}
        <div className="bg-[#111113]/40 border border-[#27272a]/60 rounded-2xl p-6 space-y-6">
          <div>
            <h3 className="text-sm font-semibold text-white">Policy Settings</h3>
            <p className="text-xs text-gray-500 font-mono">Configure security constraints and webhook configurations</p>
          </div>

          <form onSubmit={handleSaveSettings} className="space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] font-mono uppercase tracking-wider text-[#a1a1aa] font-medium">IP Address Allowlist</label>
              <input
                type="text"
                value={ipInput}
                onChange={(e) => setIpInput(e.target.value)}
                placeholder="e.g. 127.0.0.1, 192.168.1.1 (leave blank to disable restriction)"
                className="w-full bg-[#18181b]/80 border border-[#27272a] rounded-lg px-3.5 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-all font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-mono uppercase tracking-wider text-[#a1a1aa] font-medium">Data Retention Policy (TTL)</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(Number(e.target.value))}
                  className="bg-[#18181b]/80 border border-[#27272a] rounded-lg px-3.5 py-2 text-xs text-white focus:outline-none focus:border-blue-500 transition-all font-mono w-24"
                />
                <span className="text-xs text-gray-500">Days before deletion (0 = disable policy / keep forever)</span>
              </div>
            </div>

            <div className="border-t border-[#27272a]/40 pt-4 space-y-4">
              <h4 className="text-xs font-semibold text-white font-mono uppercase tracking-wider">Refinery Chunking & Locale</h4>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-mono uppercase tracking-wider text-[#a1a1aa] font-medium">Chunking Overlap (Words)</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={chunkingOverlap}
                    onChange={(e) => setChunkingOverlap(Number(e.target.value))}
                    className="w-full bg-[#18181b]/80 border border-[#27272a] rounded-lg px-3.5 py-2 text-xs text-white focus:outline-none focus:border-blue-500 transition-all font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-mono uppercase tracking-wider text-[#a1a1aa] font-medium">Chunking Strategy</label>
                  <select
                    value={chunkingStrategy}
                    onChange={(e) => setChunkingStrategy(e.target.value)}
                    className="w-full bg-[#18181b]/80 border border-[#27272a] rounded-lg px-3.5 py-2 text-xs text-white focus:outline-none focus:border-blue-500 transition-all font-mono"
                    style={{ colorScheme: "dark" }}
                  >
                    <option value="paragraph">Paragraph Boundary</option>
                    <option value="sliding_window">Sliding Window (Words)</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-mono uppercase tracking-wider text-[#a1a1aa] font-medium">Target Pipeline Locale</label>
                <select
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                  className="w-full bg-[#18181b]/80 border border-[#27272a] rounded-lg px-3.5 py-2 text-xs text-white focus:outline-none focus:border-blue-500 transition-all font-mono"
                  style={{ colorScheme: "dark" }}
                >
                  <option value="en">English (en)</option>
                  <option value="hi">Hindi (hi)</option>
                  <option value="ar">Arabic (ar)</option>
                  <option value="fr">French (fr)</option>
                </select>
              </div>
            </div>

            <div className="border-t border-[#27272a]/40 pt-4 space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] font-mono uppercase tracking-wider text-[#a1a1aa] font-medium">Webhook Target URL</label>
                <input
                  type="url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://your-service.com/webhook-receiver"
                  className="w-full bg-[#18181b]/80 border border-[#27272a] rounded-lg px-3.5 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-all font-mono"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-mono uppercase tracking-wider text-[#a1a1aa] font-medium">Webhook Secret Token</label>
                <input
                  type="text"
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                  placeholder="e.g. signature-hash-key"
                  className="w-full bg-[#18181b]/80 border border-[#27272a] rounded-lg px-3.5 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-all font-mono"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white rounded-lg py-2 text-xs font-semibold shadow-md active:scale-[0.98] transition-all flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{saving ? "Saving Policies..." : "Save Policies"}</span>
            </button>
          </form>
        </div>

        {/* Queues and Workers Column */}
        <div className="space-y-6">
          {/* Queues Stats */}
          <div className="bg-[#111113]/40 border border-[#27272a]/60 rounded-2xl p-6 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-white">Bull Queue Status</h3>
              <p className="text-xs text-gray-500 font-mono">Job processing stages depth</p>
            </div>

            {queues ? (
              <div className="space-y-4">
                <div className="p-4 bg-[#18181b]/60 rounded-xl border border-[#27272a] space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white">document:refine</span>
                    <span className="text-[9px] font-mono bg-blue-600/10 text-blue-400 border border-blue-500/20 px-1.5 py-0.5 rounded">Processor</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-center">
                    <div className="bg-[#111113]/80 p-2 rounded border border-[#27272a]/40">
                      <p className="text-xs font-mono text-gray-400">Waiting</p>
                      <p className="text-sm font-semibold text-white font-mono">{queues.refine.waiting}</p>
                    </div>
                    <div className="bg-[#111113]/80 p-2 rounded border border-[#27272a]/40">
                      <p className="text-xs font-mono text-gray-400">Active</p>
                      <p className="text-sm font-semibold text-white font-mono">{queues.refine.active}</p>
                    </div>
                    <div className="bg-[#111113]/80 p-2 rounded border border-[#27272a]/40">
                      <p className="text-xs font-mono text-gray-400">Done</p>
                      <p className="text-sm font-semibold text-green-400 font-mono">{queues.refine.completed}</p>
                    </div>
                    <div className="bg-[#111113]/80 p-2 rounded border border-[#27272a]/40">
                      <p className="text-xs font-mono text-gray-400">Fail</p>
                      <p className="text-sm font-semibold text-red-400 font-mono">{queues.refine.failed}</p>
                    </div>
                  </div>
                </div>

                <div className="p-4 bg-[#18181b]/60 rounded-xl border border-[#27272a] space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white">document:embedding</span>
                    <span className="text-[9px] font-mono bg-green-600/10 text-green-400 border border-green-500/20 px-1.5 py-0.5 rounded">Vector Sync</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-center">
                    <div className="bg-[#111113]/80 p-2 rounded border border-[#27272a]/40">
                      <p className="text-xs font-mono text-gray-400">Waiting</p>
                      <p className="text-sm font-semibold text-white font-mono">{queues.embedding.waiting}</p>
                    </div>
                    <div className="bg-[#111113]/80 p-2 rounded border border-[#27272a]/40">
                      <p className="text-xs font-mono text-gray-400">Active</p>
                      <p className="text-sm font-semibold text-white font-mono">{queues.embedding.active}</p>
                    </div>
                    <div className="bg-[#111113]/80 p-2 rounded border border-[#27272a]/40">
                      <p className="text-xs font-mono text-gray-400">Done</p>
                      <p className="text-sm font-semibold text-green-400 font-mono">{queues.embedding.completed}</p>
                    </div>
                    <div className="bg-[#111113]/80 p-2 rounded border border-[#27272a]/40">
                      <p className="text-xs font-mono text-gray-400">Fail</p>
                      <p className="text-sm font-semibold text-red-400 font-mono">{queues.embedding.failed}</p>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-xs text-gray-500 font-mono">No queue metrics available.</p>
            )}
          </div>

          {/* Workers Stats */}
          <div className="bg-[#111113]/40 border border-[#27272a]/60 rounded-2xl p-6 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-white">Active Workers</h3>
              <p className="text-xs text-gray-500 font-mono">Running process daemon health</p>
            </div>

            <div className="space-y-2">
              {workers.map((worker, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-[#18181b]/50 border border-[#27272a] rounded-lg">
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-blue-500" />
                    <div>
                      <p className="text-xs font-semibold text-white">{worker.name}</p>
                      <p className="text-[10px] text-gray-500 font-mono">Queue: {worker.queue}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      {worker.status.toUpperCase()}
                    </span>
                    <p className="text-[9px] text-gray-500 font-mono mt-1">Processed: {worker.jobsProcessed}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Webhook Delivery Logs */}
      <div className="bg-[#111113]/40 border border-[#27272a]/60 rounded-2xl p-6 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-white">Outbound Webhook Delivery logs</h3>
          <p className="text-xs text-gray-500 font-mono">Recent webhook event dispatch attempts</p>
        </div>

        {webhookLogs.length === 0 ? (
          <div className="p-8 text-center text-xs text-gray-500 font-mono bg-[#18181b]/20 border border-[#27272a]/40 rounded-xl">
            No webhook event deliveries logged.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-[#27272a] text-gray-500">
                  <th className="py-2.5 font-medium">Event</th>
                  <th className="py-2.5 font-medium">Target URL</th>
                  <th className="py-2.5 font-medium text-center">Status</th>
                  <th className="py-2.5 font-medium text-center">HTTP Status</th>
                  <th className="py-2.5 font-medium text-center">Attempts</th>
                  <th className="py-2.5 font-medium text-right">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#27272a]/40 text-gray-300">
                {webhookLogs.map((log) => (
                  <tr key={log._id} className="hover:bg-[#18181b]/30">
                    <td className="py-3 font-semibold text-blue-400">{log.event}</td>
                    <td className="py-3 text-gray-400 truncate max-w-xs" title={log.url}>{log.url}</td>
                    <td className="py-3 text-center">
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold ${
                        log.status === "success" 
                          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" 
                          : "bg-red-500/10 text-red-400 border border-red-500/20"
                      }`}>
                        {log.status === "success" ? (
                          <>
                            <CheckCircle className="w-2.5 h-2.5" />
                            Success
                          </>
                        ) : (
                          <>
                            <XCircle className="w-2.5 h-2.5" />
                            Failed
                          </>
                        )}
                      </span>
                    </td>
                    <td className="py-3 text-center font-bold text-white">{log.statusCode || "N/A"}</td>
                    <td className="py-3 text-center">{log.attempts}</td>
                    <td className="py-3 text-right text-gray-500">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
