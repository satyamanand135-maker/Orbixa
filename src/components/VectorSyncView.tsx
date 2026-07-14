import React, { useState } from "react";
import { 
  Database, 
  Cpu, 
  ShieldCheck, 
  RefreshCw, 
  Settings2, 
  Server, 
  Sparkles,
  Search,
  CheckCircle2,
  AlertCircle
} from "lucide-react";

interface VectorDb {
  id: string;
  name: string;
  status: "active" | "inactive" | "testing";
  indexName: string;
  dimensions: number;
  latencyMs: number;
  vectorsCount: number;
  embeddingModel: string;
}

export default function VectorSyncView() {
  const [dbs, setDbs] = useState<VectorDb[]>([
    { id: "qdrant", name: "Qdrant Cloud Cluster", status: "active", indexName: "acme-knowledge-base", dimensions: 1536, latencyMs: 14, vectorsCount: 142, embeddingModel: "gemini-embedding-2-preview" },
    { id: "pinecone", name: "Pinecone Serverless Index", status: "active", indexName: "acme-enterprise-index", dimensions: 1536, latencyMs: 24, vectorsCount: 142, embeddingModel: "gemini-embedding-2-preview" },
    { id: "weaviate", name: "Weaviate Sandbox Cluster", status: "inactive", indexName: "Unconfigured", dimensions: 1536, latencyMs: 0, vectorsCount: 0, embeddingModel: "gemini-embedding-2-preview" },
    { id: "chroma", name: "Local Chroma DB Container", status: "inactive", indexName: "Unconfigured", dimensions: 1536, latencyMs: 0, vectorsCount: 0, embeddingModel: "gemini-embedding-2-preview" }
  ]);

  const [testingId, setTestingId] = useState<string | null>(null);
  const [activeConfigId, setActiveConfigId] = useState<string | null>(null);

  const handleTestConnection = (id: string) => {
    setTestingId(id);
    
    // Simulate connection ping
    setTimeout(() => {
      setDbs(prev => prev.map(db => {
        if (db.id === id) {
          return {
            ...db,
            status: "active",
            latencyMs: 8 + Math.floor(Math.random() * 20),
            vectorsCount: db.vectorsCount > 0 ? db.vectorsCount : Math.floor(Math.random() * 50) + 10
          };
        }
        return db;
      }));
      setTestingId(null);
    }, 2000);
  };

  const toggleConnection = (id: string) => {
    setDbs(prev => prev.map(db => {
      if (db.id === id) {
        const isCurrentlyActive = db.status === "active";
        return {
          ...db,
          status: isCurrentlyActive ? "inactive" : "active",
          indexName: isCurrentlyActive ? "Unconfigured" : `acme-index-${db.id}`,
          vectorsCount: isCurrentlyActive ? 0 : 45,
          latencyMs: isCurrentlyActive ? 0 : 15
        };
      }
      return db;
    }));
  };

  return (
    <div id="vector-sync-view" className="space-y-6">
      {/* Header section */}
      <div>
        <h2 className="text-xl font-display font-semibold text-white tracking-wide flex items-center gap-2">
          <Database className="w-5 h-5 text-[#3b82f6]" />
          Vector Storage Synchronization Nodes
        </h2>
        <p className="text-xs text-gray-400 mt-1 max-w-xl">
          Securely map processed semantic chunks directly to vector indexes. Clean Data Hub maintains state version synchronization to bypass database conflicts.
        </p>
      </div>

      {/* Grid of databases */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {dbs.map((db) => {
          const isConfigOpen = activeConfigId === db.id;
          const isTesting = testingId === db.id;
          
          return (
            <div 
              key={db.id} 
              className={`bg-[#18181b] border rounded-xl overflow-hidden shadow-xl transition-all ${
                db.status === "active" ? "border-[#27272a] hover:border-[#3b82f6]/10" : "border-[#27272a] opacity-80"
              }`}
            >
              {/* Card Contents */}
              <div className="p-6 space-y-4">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Server className="w-4 h-4 text-zinc-500" />
                      <h3 className="text-sm font-semibold text-white tracking-tight">{db.name}</h3>
                    </div>
                    <span className="text-[10px] font-mono text-zinc-500 font-medium">Model: {db.embeddingModel}</span>
                  </div>

                  {/* Operational Status */}
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-mono font-bold ${
                    isTesting 
                      ? "bg-blue-500/10 text-blue-400 border border-blue-500/20" 
                      : (db.status === "active" 
                          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" 
                          : "bg-zinc-800 text-zinc-400 border border-zinc-700")
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      isTesting ? "bg-blue-500 animate-spin" : (db.status === "active" ? "bg-emerald-500 animate-pulse" : "bg-zinc-500")
                    }`}></span>
                    {isTesting ? "Testing" : (db.status === "active" ? "Operational" : "Not Configured")}
                  </span>
                </div>

                {/* DB Metadata Grid */}
                <div className="grid grid-cols-3 gap-3 text-[10px] font-mono text-gray-400 bg-[#111113] p-3.5 rounded-lg border border-[#27272a] text-center">
                  <div className="space-y-1 border-r border-[#27272a]">
                    <span className="text-zinc-500 block">DIMS</span>
                    <span className="text-gray-200 font-bold">{db.dimensions}</span>
                  </div>
                  <div className="space-y-1 border-r border-[#27272a]">
                    <span className="text-zinc-500 block">LATENCY</span>
                    <span className="text-gray-200 font-bold">{db.status === "active" ? `${db.latencyMs}ms` : "—"}</span>
                  </div>
                  <div className="space-y-1">
                    <span className="text-zinc-500 block">VECTORS</span>
                    <span className="text-gray-200 font-bold">{db.status === "active" ? db.vectorsCount : "0"}</span>
                  </div>
                </div>

                {/* Sub row showing Index Name */}
                <div className="text-[10px] font-mono text-gray-400 flex justify-between items-center bg-[#111113] px-3.5 py-2 rounded border border-[#27272a]/40">
                  <span className="text-gray-500">INDEX LOCATION:</span>
                  <span className="text-gray-200 font-semibold">{db.indexName}</span>
                </div>

                {/* Actions row */}
                <div className="flex items-center justify-between pt-2">
                  <button
                    onClick={() => setActiveConfigId(isConfigOpen ? null : db.id)}
                    className="text-[11px] font-mono font-semibold text-gray-400 hover:text-white flex items-center gap-1 bg-transparent border-0 cursor-pointer"
                  >
                    <Settings2 className="w-3.5 h-3.5 text-gray-500" />
                    Credentials Settings
                  </button>

                  <div className="flex gap-2">
                    <button
                      disabled={isTesting}
                      onClick={() => handleTestConnection(db.id)}
                      className="px-2.5 py-1.5 text-[10px] font-bold text-zinc-400 hover:text-white hover:bg-zinc-800 rounded border border-[#27272a] flex items-center gap-1 transition-all cursor-pointer bg-transparent"
                    >
                      <RefreshCw className={`w-3 h-3 ${isTesting ? "animate-spin" : ""}`} />
                      Ping Node
                    </button>
                    <button
                      onClick={() => toggleConnection(db.id)}
                      className={`px-3 py-1.5 text-[10px] font-bold rounded cursor-pointer ${
                        db.status === "active" 
                          ? "bg-transparent border border-red-500/10 text-red-400 hover:bg-red-500/10" 
                          : "bg-[#3b82f6] border border-transparent text-white hover:bg-blue-600 hover:text-white"
                      }`}
                    >
                      {db.status === "active" ? "Deactivate" : "Activate"}
                    </button>
                  </div>
                </div>
              </div>

              {/* Collapsible settings details */}
              {isConfigOpen && (
                <div className="border-t border-[#27272a] bg-[#111113] p-6 space-y-4 animate-slide-down text-xs">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[9px] font-mono font-bold text-zinc-500 uppercase mb-1">Index Endpoint Host / URI</label>
                      <input 
                        type="text" 
                        disabled={db.status !== "active"}
                        placeholder={db.status === "active" ? `https://acme-cluster-${db.id}.cloud.qdrant.io` : "https://index-endpoint-uri..."}
                        className="w-full bg-[#18181b] border border-[#27272a] rounded px-2.5 py-1.5 font-mono text-xs text-white focus:outline-none focus:border-[#3b82f6]" 
                      />
                    </div>
                    <div>
                      <label className="block text-[9px] font-mono font-bold text-zinc-500 uppercase mb-1">Authorization API Key</label>
                      <input 
                        type="password" 
                        disabled={db.status !== "active"}
                        value={db.status === "active" ? "••••••••••••••••••••••••" : ""}
                        placeholder="Insert Vector Store API Key"
                        className="w-full bg-[#18181b] border border-[#27272a] rounded px-2.5 py-1.5 font-mono text-xs text-white focus:outline-none focus:border-[#3b82f6]" 
                      />
                    </div>
                  </div>
                  <div className="pt-2 flex items-center gap-1 text-[10px] text-zinc-500">
                    <Sparkles className="w-3.5 h-3.5 text-[#3b82f6]" />
                    <span>Automatically uses </span>
                    <span className="text-gray-300 font-bold font-mono">gemini-embedding-2-preview</span>
                    <span> to synchronize index entries on saving.</span>
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
