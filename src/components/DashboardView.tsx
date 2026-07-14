import React, { useState } from "react";
import { 
  FileText, 
  Plus, 
  Trash2, 
  Database, 
  ShieldAlert, 
  Award, 
  Cpu, 
  RefreshCw,
  Clock,
  ArrowRight,
  Info,
  CheckCircle2,
  AlertCircle,
  UploadCloud
} from "lucide-react";
import { DocumentRecord } from "../types";

interface DashboardViewProps {
  documents: DocumentRecord[];
  onSelectDoc: (doc: DocumentRecord) => void;
  onRefineDoc: (docId: string) => Promise<void>;
  onDeleteDoc: (docId: string) => Promise<void>;
  onUploadDoc: (name: string, content: string, type: "PDF" | "DOCX" | "XLSX" | "TXT", connector: string) => Promise<void>;
  stats: any;
  loadingStates: { [key: string]: boolean };
}

export default function DashboardView({
  documents,
  onSelectDoc,
  onRefineDoc,
  onDeleteDoc,
  onUploadDoc,
  stats,
  loadingStates
}: DashboardViewProps) {
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [pasteName, setPasteName] = useState("");
  const [pasteContent, setPasteContent] = useState("");
  const [pasteType, setPasteType] = useState<"PDF" | "DOCX" | "XLSX" | "TXT">("TXT");
  const [pasteConnector, setPasteConnector] = useState("Local Upload");
  const [isDragging, setIsDragging] = useState(false);

  // Quick preset data for paste tests
  const populatePreset = (presetType: string) => {
    if (presetType === "finance") {
      setPasteName("acme_ledger_leaks.html");
      setPasteType("XLSX");
      setPasteConnector("SharePoint");
      setPasteContent(`ACME PARTNERSHIP GROUP RECORD - confidential. Page 1.
Date: 2026-06-25
======================================
Transactions Ledger details:
Jane Doe (jane@acme.com) phone: 206-555-0143
Wire routing: 021000021, bank account: 987654321
Salary details: $185,000 baseline, plus quarterly bonuses.
Jane Doe (jane@acme.com) phone: 206-555-0143
Wire routing: 021000021, bank account: 987654321`);
    } else if (presetType === "medical") {
      setPasteName("patient_charts_unsecured.txt");
      setPasteType("TXT");
      setPasteConnector("Local Upload");
      setPasteContent(`PATIENT CARE RECORD - DR. HOUSE CLINIC
Patient Name: Robert Smith
DOB: 11/12/1980, Email: r.smith80@yahoo.com
Primary Diagnosis: Type 2 Diabetes Mellitus
SSN Number: 000-44-5566
Robert has shown high compliance with insulin instructions. 
Email updates sent to r.smith80@yahoo.com weekly.`);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      const reader = new FileReader();
      reader.onload = async (event) => {
        const text = event.target?.result as string;
        const extension = file.name.split(".").pop()?.toUpperCase() || "TXT";
        const docType = ["PDF", "DOCX", "XLSX", "TXT"].includes(extension)
          ? (extension as "PDF" | "DOCX" | "XLSX" | "TXT")
          : "TXT";
        
        await onUploadDoc(file.name, text, docType, "Local Upload");
      };
      reader.readAsText(file);
    }
  };

  const handlePasteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pasteName || !pasteContent) return;
    await onUploadDoc(pasteName, pasteContent, pasteType, pasteConnector);
    setPasteName("");
    setPasteContent("");
    setShowUploadModal(false);
  };

  // KPI Definition List
  const kpiCards = [
    {
      title: "Data Sources Synced",
      value: stats.totalDocs || 0,
      subtext: `${documents.filter(d => d.status === "raw").length} unprocessed raw documents`,
      icon: Database,
      colorClass: "text-[#3b82f6] bg-[#3b82f6]/5 border-[#27272a]",
    },
    {
      title: "Semantic Chunks Synced",
      value: stats.totalChunks || 0,
      subtext: "Upserted to Qdrant & Pinecone",
      icon: Cpu,
      colorClass: "text-purple-400 bg-purple-500/5 border-[#27272a]",
    },
    {
      title: "Sensitive PII Masked",
      value: stats.totalPii || 0,
      subtext: "Redacted via zero-trust shield",
      icon: ShieldAlert,
      colorClass: "text-red-400 bg-red-500/5 border-[#27272a]",
    },
    {
      title: "Average AI Readiness",
      value: `${stats.avgReadiness || 92}%`,
      subtext: "Clean, token-optimal formatting",
      icon: Award,
      colorClass: "text-[#10b981] bg-[#10b981]/5 border-[#27272a]",
    },
  ];

  return (
    <div id="dashboard-view" className="space-y-8">
      {/* Title Header */}
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-xl font-display font-semibold text-white tracking-wide">Refinery Control Center</h2>
          <p className="text-xs text-gray-400 mt-1 leading-relaxed max-w-xl">
            Prepare, sanitize, and partition your messy corporate knowledge assets into fully structures suitable for search indexing.
          </p>
        </div>
        
        <button
          onClick={() => setShowUploadModal(true)}
          className="flex items-center gap-2 px-3.5 py-2 bg-[#3b82f6] hover:bg-blue-600 active:scale-95 text-xs text-white font-semibold rounded-lg shadow-lg shadow-[#3b82f6]/10 transition-all cursor-pointer border-0"
        >
          <Plus className="w-4 h-4 text-inherit" />
          Ingest Enterprise Asset
        </button>
      </div>

      {/* KPI Matrix Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpiCards.map((card, idx) => {
          const Icon = card.icon;
          return (
            <div 
              key={idx} 
              className={`p-5 bg-[#18181b] border border-[#27272a] rounded-xl flex items-start justify-between ${card.colorClass}`}
            >
              <div className="space-y-1.5">
                <span className="text-[10px] font-mono font-semibold uppercase tracking-wider text-gray-500">{card.title}</span>
                <p className="text-2xl font-semibold text-white tracking-tight">{card.value}</p>
                <span className="text-[10px] text-gray-400 block">{card.subtext}</span>
              </div>
              <div className="p-2.5 rounded-lg bg-gray-900/40">
                <Icon className="w-5 h-5 text-inherit" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Drag & Drop Upload Quick Target */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-xl p-8 text-center transition-all ${
          isDragging 
            ? "border-[#3b82f6] bg-[#3b82f6]/5 text-[#3b82f6]" 
            : "border-[#27272a] hover:border-[#3f3f46] bg-[#111113] text-gray-400"
        }`}
      >
        <div className="max-w-md mx-auto flex flex-col items-center gap-2">
          <div className="p-3 bg-[#18181b] rounded-xl border border-[#27272a]">
            <UploadCloud className={`w-6 h-6 ${isDragging ? "text-[#3b82f6] animate-bounce" : "text-gray-400"}`} />
          </div>
          <p className="text-xs text-white font-medium mt-2">
            Drag & drop raw documents here to trigger secure ingest
          </p>
          <p className="text-[10px] text-gray-500 font-mono">
            Supports: PDF, DOCX, XLSX, TXT (Auto layout parsing & clean-up)
          </p>
          <button
            onClick={() => setShowUploadModal(true)}
            className="text-[10px] text-[#3b82f6] hover:text-blue-400 underline font-semibold mt-1.5 cursor-pointer bg-transparent border-0"
          >
            Or manually copy-paste raw contents
          </button>
        </div>
      </div>

      {/* Primary Ingestion Documents Table */}
      <div className="bg-[#18181b] border border-[#27272a] rounded-xl overflow-hidden shadow-xl">
        <div className="px-6 py-4 border-b border-[#27272a] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <FileText className="w-4 h-4 text-[#3b82f6]" />
            <h3 className="text-xs font-semibold text-white">Active Data Refinery Pipeline</h3>
          </div>
          <div className="text-[10px] font-mono text-gray-500 flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" />
            Showing {documents.length} registered documents
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#27272a] bg-[#111113] text-[#a1a1aa] text-[10px] font-mono uppercase tracking-wider">
                <th className="px-6 py-3 font-semibold">Document Name</th>
                <th className="px-6 py-3 font-semibold">Source Connector</th>
                <th className="px-6 py-3 font-semibold">Size</th>
                <th className="px-6 py-3 font-semibold">Status</th>
                <th className="px-6 py-3 font-semibold text-center">PII Filtered</th>
                <th className="px-6 py-3 font-semibold text-center">Readiness Score</th>
                <th className="px-6 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#27272a] text-xs">
              {documents.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-[#a1a1aa]">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <AlertCircle className="w-6 h-6 text-gray-600" />
                      <p className="text-xs font-medium text-[#a1a1aa]">No raw assets loaded</p>
                      <p className="text-[10px] text-gray-500 max-w-xs">
                        Upload or copy-paste unstructured content to watch the automated data pipeline in action.
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                documents.map((doc) => {
                  const isProcessing = loadingStates[doc.id] || doc.status === "processing";
                  return (
                    <tr 
                      key={doc.id}
                      className="hover:bg-[#27272a]/30 transition-colors group"
                    >
                      {/* Name */}
                      <td className="px-6 py-4 font-medium text-white max-w-xs truncate">
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-gray-500 group-hover:text-[#3b82f6] transition-colors" />
                          <span className="truncate">{doc.name}</span>
                        </div>
                      </td>
                      
                      {/* Source */}
                      <td className="px-6 py-4 text-[#a1a1aa] font-mono text-[10px]">
                        {doc.connector}
                      </td>

                      {/* Size */}
                      <td className="px-6 py-4 text-[#a1a1aa] font-mono text-[10px]">
                        {doc.size}
                      </td>

                      {/* Status */}
                      <td className="px-6 py-4">
                        {doc.status === "refined" ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-semibold bg-[#10b981]/10 text-[#10b981] border border-[#10b981]/20">
                            <CheckCircle2 className="w-3 h-3" /> Refined
                          </span>
                        ) : doc.status === "processing" || isProcessing ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-semibold bg-[#3b82f6]/10 text-[#3b82f6] border border-[#3b82f6]/20">
                            <RefreshCw className="w-3 h-3 animate-spin" /> Refining
                          </span>
                        ) : doc.status === "failed" ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-semibold bg-red-500/10 text-red-400 border border-red-500/20">
                            <AlertCircle className="w-3 h-3" /> Failed
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-semibold bg-[#27272a]/40 text-[#a1a1aa] border border-[#27272a]">
                            Raw Asset
                          </span>
                        )}
                      </td>

                      {/* PII Count */}
                      <td className="px-6 py-4 text-center font-mono text-[11px] text-gray-300">
                        {doc.status === "refined" ? (
                          <span className={`px-1.5 py-0.5 rounded font-bold ${doc.piiFindingsCount > 0 ? "bg-red-500/10 text-red-400 border border-red-500/10" : "bg-zinc-800 text-[#a1a1aa]"}`}>
                            {doc.piiFindingsCount} detected
                          </span>
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>

                      {/* Score */}
                      <td className="px-6 py-4 text-center font-mono font-semibold text-[11px]">
                        {doc.status === "refined" && doc.readinessScore ? (
                          <span className={`px-2 py-0.5 rounded-full ${
                            doc.readinessScore.score >= 95 
                              ? "text-[#10b981] bg-[#10b981]/10 border border-[#10b981]/20" 
                              : "text-[#f59e0b] bg-[#f59e0b]/10 border border-[#f59e0b]/20"
                          }`}>
                            {doc.readinessScore.score}/100
                          </span>
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-2 opacity-90 group-hover:opacity-100 transition-opacity">
                          {doc.status === "refined" ? (
                            <button
                              onClick={() => onSelectDoc(doc)}
                              className="px-2.5 py-1 text-[10px] font-bold text-[#10b981] hover:text-emerald-300 hover:bg-[#10b981]/5 rounded border border-[#10b981]/20 flex items-center gap-1 transition-all cursor-pointer bg-transparent"
                            >
                              Explore Output <ArrowRight className="w-3 h-3" />
                            </button>
                          ) : (
                            <button
                              disabled={isProcessing}
                              onClick={() => onRefineDoc(doc.id)}
                              className="px-2.5 py-1 text-[10px] font-bold bg-[#3b82f6] hover:bg-blue-600 disabled:bg-[#18181b] text-white rounded flex items-center gap-1 transition-all cursor-pointer border-0"
                            >
                              {isProcessing ? (
                                <>
                                  <RefreshCw className="w-3 h-3 animate-spin" /> In Progress
                                </>
                              ) : (
                                <>
                                  <Cpu className="w-3 h-3" /> Refine Asset
                                </>
                              )}
                            </button>
                          )}
                          
                          <button
                            onClick={() => onDeleteDoc(doc.id)}
                            className="p-1 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors cursor-pointer bg-transparent border-0"
                            title="Delete record"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Copy-Paste Manual Ingest Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-[#18181b] border border-[#27272a] rounded-xl w-full max-w-2xl overflow-hidden shadow-2xl">
            <div className="px-6 py-4 border-b border-[#27272a] flex justify-between items-center bg-[#111113]">
              <h4 className="text-xs font-semibold text-white flex items-center gap-2">
                <UploadCloud className="w-4 h-4 text-[#3b82f6]" />
                Manually Ingest Raw Unstructured Data
              </h4>
              <button
                type="button"
                onClick={() => setShowUploadModal(false)}
                className="text-[#a1a1aa] hover:text-white font-mono text-xs cursor-pointer bg-transparent border-0"
              >
                ✕ Close
              </button>
            </div>
 
            <form onSubmit={handlePasteSubmit} className="p-6 space-y-4">
              {/* Presets Quickbar */}
              <div>
                <p className="text-[10px] text-[#a1a1aa] mb-1.5 font-semibold">Load Sample Messy Presets:</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => populatePreset("finance")}
                    className="px-2.5 py-1 bg-[#3b82f6]/10 border border-[#3b82f6]/20 text-[#3b82f6] hover:bg-[#3b82f6]/20 text-[10px] rounded transition-all cursor-pointer"
                  >
                    Load: Messy Financial Ledger with Repetitions
                  </button>
                  <button
                    type="button"
                    onClick={() => populatePreset("medical")}
                    className="px-2.5 py-1 bg-purple-500/10 border border-purple-500/20 text-purple-400 hover:bg-purple-500/20 text-[10px] rounded transition-all cursor-pointer"
                  >
                    Load: Unsecured Medical Charts with PII
                  </button>
                </div>
              </div>
 
              {/* Form inputs */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-mono text-[#a1a1aa] mb-1">Document Asset Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g., support_transcript_q3.txt"
                    value={pasteName}
                    onChange={(e) => setPasteName(e.target.value)}
                    className="w-full bg-[#111113] border border-[#27272a] rounded px-3 py-1.5 text-xs text-white focus:outline-none focus:border-[#3b82f6] font-mono"
                  />
                </div>
                
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] font-mono text-[#a1a1aa] mb-1">Doc Type</label>
                    <select
                      value={pasteType}
                      onChange={(e) => setPasteType(e.target.value as any)}
                      className="w-full bg-[#111113] border border-[#27272a] rounded px-3 py-1.5 text-xs text-white focus:outline-none focus:border-[#3b82f6]"
                    >
                      <option value="TXT">TXT</option>
                      <option value="PDF">PDF</option>
                      <option value="DOCX">DOCX</option>
                      <option value="XLSX">XLSX</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-mono text-[#a1a1aa] mb-1">Connector</label>
                    <select
                      value={pasteConnector}
                      onChange={(e) => setPasteConnector(e.target.value)}
                      className="w-full bg-[#111113] border border-[#27272a] rounded px-3 py-1.5 text-xs text-white focus:outline-none focus:border-[#3b82f6]"
                    >
                      <option value="Local Upload">Local Upload</option>
                      <option value="Google Drive">Google Drive</option>
                      <option value="SharePoint">SharePoint</option>
                      <option value="GitHub">GitHub</option>
                    </select>
                  </div>
                </div>
              </div>
 
              <div>
                <label className="block text-[10px] font-mono text-[#a1a1aa] mb-1">Raw Messy Content</label>
                <textarea
                  required
                  rows={8}
                  placeholder="Paste raw unstructured logs, charts, emails, transcripts, SQL chunks, or sheets with messy layout, duplicate footer lines, active API keys, emails, phone numbers, etc."
                  value={pasteContent}
                  onChange={(e) => setPasteContent(e.target.value)}
                  className="w-full bg-[#111113] border border-[#27272a] rounded p-3 text-xs text-white focus:outline-none focus:border-[#3b82f6] font-mono leading-relaxed"
                ></textarea>
              </div>
 
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowUploadModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-[#a1a1aa] hover:text-white transition-colors cursor-pointer bg-transparent border-0"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold bg-[#3b82f6] hover:bg-blue-600 text-white rounded-lg cursor-pointer border-0"
                >
                  Ingest Asset
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
