import React, { useState, useMemo } from "react";
import {
  ShieldCheck,
  Server,
  CreditCard,
  Scissors,
  FileCheck,
  Link2,
  Database,
  FileText,
  Search,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Filter,
} from "lucide-react";

type Priority = "critical" | "high" | "medium" | "low";
type Status = "fixed" | "in_progress" | "pending" | "backlog";

interface Gap {
  id: string;
  gap: string;
  current: string;
  fix: string;
  priority: Priority;
  effort: string;
  status: Status;
}

interface GapCategory {
  id: string;
  label: string;
  icon: React.ElementType;
  color: string;
  gaps: Gap[];
}

const GAP_DATA: GapCategory[] = [
  {
    id: "auth",
    label: "Auth & Security",
    icon: ShieldCheck,
    color: "text-blue-400",
    gaps: [
      {
        id: "auth-1",
        gap: "SSO/SAML not implemented",
        current: "OpenIDConnect / JWTs only — no enterprise SSO or SAML federation",
        fix: "Integrate passport-saml, configure IdP metadata, assertion parsing, scoping, assertion passing",
        priority: "high",
        effort: "2 wks",
        status: "pending",
      },
      {
        id: "auth-2",
        gap: "Rate-limiting is in-memory / leaky",
        current: "Lost on restarts, not effective, not distributed at cluster scale",
        fix: "Redis-backed rate limiter using ioredis. Store rate-limit counters in Redis with fixed sliding window",
        priority: "high",
        effort: "1 day",
        status: "fixed",
      },
      {
        id: "auth-3",
        gap: "No secrets manager",
        current: "All credentials in .env file — single leaked file exposes full production access",
        fix: "AWS Secrets Manager / HashiCorp Vault for per-service credential retrieval at boot",
        priority: "high",
        effort: "3 days",
        status: "pending",
      },
    ],
  },
  {
    id: "backend",
    label: "Backend",
    icon: Server,
    color: "text-purple-400",
    gaps: [
      {
        id: "backend-1",
        gap: "Python sidecar not full Celery workers",
        current: "pdf_parser.py called via blocking process.call() — blocks main thread, no parallelism, queue, retries",
        fix: "Dedicated Python Celery workers spawning multiple agents, table-queue, poison-errors, and backoff",
        priority: "high",
        effort: "3–4 wks",
        status: "in_progress",
      },
      {
        id: "backend-2",
        gap: "No Python FastAPI control plane",
        current: "Python libraries used only as sidecar microservices (pdf_parser.py)",
        fix: "Full FastAPI service for processing API section routes, retrying, job life cycle and model management",
        priority: "high",
        effort: "4–6 wks",
        status: "pending",
      },
    ],
  },
  {
    id: "billing",
    label: "Billing",
    icon: CreditCard,
    color: "text-yellow-400",
    gaps: [
      {
        id: "billing-1",
        gap: "No Stripe / usage metering",
        current: "No payment system — SaaS cannot charge per document, volume, or seat",
        fix: "Integrate Stripe, per-tenant metering, document-per-unit quotas, tiered plan enforcement",
        priority: "high",
        effort: "3 wks",
        status: "backlog",
      },
      {
        id: "billing-2",
        gap: "No plan-quota enforcement",
        current: "Allows bulk documents for free with no metering or volume caps at any tier",
        fix: "Enforce quota tables at log-in per tenant with a documents cap per plan. Reject 429 when limit exceeded",
        priority: "high",
        effort: "1 wk",
        status: "backlog",
      },
    ],
  },
  {
    id: "chunking",
    label: "Chunking",
    icon: Scissors,
    color: "text-orange-400",
    gaps: [
      {
        id: "chunking-1",
        gap: "Only basic paragraph-split chunking",
        current: "Fixed-char split — no semantic, table-aware, or intelligent boundary logic or token-count enforced",
        fix: "Add semantic boundary, sliding window, token-count (tiktoken), and configurable chunking mode with overlap",
        priority: "high",
        effort: "2 wks",
        status: "pending",
      },
      {
        id: "chunking-2",
        gap: "No token-based chunking",
        current: "Character count used — inaccurate for LLMs that measure in tokens for context limits",
        fix: "Integrate tiktoken for token-count chunking — enforce per-model context limits accurately",
        priority: "medium",
        effort: "3 days",
        status: "pending",
      },
    ],
  },
  {
    id: "compliance",
    label: "Compliance",
    icon: FileCheck,
    color: "text-emerald-400",
    gaps: [
      {
        id: "compliance-1",
        gap: "Not SOC2 ready",
        current: "Audit logs not live on policies, pim-own, or non-repudiation requirements for SOC2 Type 2",
        fix: "Controls documented, pim-on, audit logs per user action, certifications required for SOC2 readiness",
        priority: "high",
        effort: "6 months",
        status: "backlog",
      },
      {
        id: "compliance-2",
        gap: "Not HIPAA ready",
        current: "No BAA with cloud providers, no PHI metadata classification, no detailed audit per PII field logging",
        fix: "BAA signed, PHI fields classified, audit logs per PHI field, encryption at rest + in transit",
        priority: "high",
        effort: "3 months",
        status: "backlog",
      },
      {
        id: "compliance-3",
        gap: "Not GDPR compliant",
        current: "No data deletion API, no data export, no tracking, no DPA in place, no residency control",
        fix: "Right-to-erase endpoints, data-export API, residency tracking, DPA in place",
        priority: "high",
        effort: "2 months",
        status: "backlog",
      },
    ],
  },
  {
    id: "connectors",
    label: "Connectors",
    icon: Link2,
    color: "text-cyan-400",
    gaps: [
      {
        id: "connectors-1",
        gap: "All connectors are UI mockups",
        current: "Connector screens but no actual HTTP/OAuth calls to Google Drive, Notion, Confluence, Slack, S3",
        fix: "Real OAuth2 / API flows for Google, Notion, Confluence, GitHub, Slack, S3",
        priority: "high",
        effort: "8–12 wks",
        status: "in_progress",
      },
      {
        id: "connectors-2",
        gap: "No scheduled sync",
        current: "Bull repeat jobs now schedule connector re-syncs through the connector schedule endpoint",
        fix: "Implemented Bull-backed hourly/daily/weekly connector schedules",
        priority: "high",
        effort: "1 wk",
        status: "pending",
      },
      {
        id: "connectors-3",
        gap: "No incremental / change detection",
        current: "Connector sync state now tracks checksum, ETag, modifiedAt, documentId, and deletedAt per source file",
        fix: "Implemented fingerprint-based skip/update/delete decisions in the connector worker",
        priority: "high",
        effort: "1 wk",
        status: "pending",
      },
    ],
  },
  {
    id: "database",
    label: "Database",
    icon: Database,
    color: "text-indigo-400",
    gaps: [
      {
        id: "database-1",
        gap: "MongoDB instead of PostgreSQL",
        current: "MongoDB with no row-level security — true multi-tenancy requires PostgreSQL RLS for full isolation",
        fix: "Migrate to PostgreSQL + Elastic, use JSONB + RLS policies for tenant data isolation",
        priority: "high",
        effort: "3–4 wks",
        status: "backlog",
      },
      {
        id: "database-2",
        gap: "No migration system",
        current: "Versioned migration runner and connector indexes now live under scripts/ and migrations/",
        fix: "Implemented npm run db:migrate for ordered migration execution",
        priority: "high",
        effort: "1 wk",
        status: "pending",
      },
      {
        id: "database-3",
        gap: "No automated backups",
        current: "JSON collection backup script is available through npm run db:backup",
        fix: "Implemented backup runner; production PITR/cross-region policy remains infrastructure work",
        priority: "high",
        effort: "1 day",
        status: "pending",
      },
    ],
  },
  {
    id: "doc_parsing",
    label: "Document Parsing",
    icon: FileText,
    color: "text-rose-400",
    gaps: [
      {
        id: "doc-1",
        gap: "No OCR for scanned PDFs",
        current: "OCR sidecar hook is available when OCR_PROVIDER and pytesseract/Pillow are configured",
        fix: "Implemented OCR command hook with clear fallback errors when OCR dependencies are absent",
        priority: "high",
        effort: "1 wk",
        status: "pending",
      },
      {
        id: "doc-2",
        gap: "No DOCX / XLSX / JSON parsing",
        current: "Parser dispatch now supports PDF, TXT, DOCX, XLSX, and PPTX through optional sidecar libraries",
        fix: "Implemented sidecar commands for python-docx, openpyxl, python-pptx, and OCR",
        priority: "high",
        effort: "2 wks",
        status: "in_progress",
      },
    ],
  },
];

const PRIORITY_CONFIG: Record<Priority, { label: string; cls: string }> = {
  critical: { label: "P0", cls: "bg-red-500/20 text-red-400 border border-red-500/30" },
  high:     { label: "P1", cls: "bg-orange-500/20 text-orange-400 border border-orange-500/30" },
  medium:   { label: "P2", cls: "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30" },
  low:      { label: "P3", cls: "bg-gray-500/20 text-gray-400 border border-gray-500/30" },
};

const STATUS_CONFIG: Record<Status, { label: string; icon: any; cls: string }> = {
  fixed:       { label: "Fixed",       icon: CheckCircle2,   cls: "text-emerald-400" },
  in_progress: { label: "In Progress", icon: Clock,           cls: "text-blue-400" },
  pending:     { label: "Pending",     icon: AlertTriangle,   cls: "text-yellow-400" },
  backlog:     { label: "Backlog",     icon: Clock,           cls: "text-gray-500" },
};

type FilterStatus   = "all" | Status;
type FilterPriority = "all" | Priority;

export default function GapsView() {
  const [search,            setSearch]            = useState("");
  const [statusFilter,      setStatusFilter]      = useState<FilterStatus>("all");
  const [priorityFilter,    setPriorityFilter]    = useState<FilterPriority>("all");
  const [collapsed,         setCollapsed]         = useState<Set<string>>(new Set());

  const toggle = (id: string) => setCollapsed(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return GAP_DATA.map(cat => ({
      ...cat,
      gaps: cat.gaps.filter(g => {
        const matchQ  = !q || g.gap.toLowerCase().includes(q) || g.current.toLowerCase().includes(q) || g.fix.toLowerCase().includes(q);
        const matchS  = statusFilter   === "all" || g.status   === statusFilter;
        const matchP  = priorityFilter === "all" || g.priority === priorityFilter;
        return matchQ && matchS && matchP;
      }),
    })).filter(c => c.gaps.length > 0);
  }, [search, statusFilter, priorityFilter]);

  const allGaps   = GAP_DATA.flatMap(c => c.gaps);
  const total     = allGaps.length;
  const fixedCnt  = allGaps.filter(g => g.status === "fixed").length;
  const inProgCnt = allGaps.filter(g => g.status === "in_progress").length;
  const pendCnt   = allGaps.filter(g => g.status === "pending").length;

  return (
    <div id="gaps-view" className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#27272a] pb-6">
        <div>
          <h2 className="text-xl font-display font-semibold text-white tracking-wide flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-yellow-400" />
            Industry Standards Gap Tracker
          </h2>
          <p className="text-xs text-gray-400 mt-1 max-w-xl">
            {total} identified enterprise gaps across {GAP_DATA.length} categories. Track remediation toward production readiness.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-mono">
            <CheckCircle2 className="w-3.5 h-3.5" /> {fixedCnt} Fixed
          </span>
          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-mono">
            <Clock className="w-3.5 h-3.5" /> {inProgCnt} In Progress
          </span>
          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-xs font-mono">
            <AlertTriangle className="w-3.5 h-3.5" /> {pendCnt} Pending
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="bg-[#18181b] border border-[#27272a] rounded-xl p-4 space-y-2">
        <div className="flex justify-between text-[10px] font-mono text-gray-400">
          <span>Overall Remediation Progress</span>
          <span>{Math.round((fixedCnt / total) * 100)}% complete</span>
        </div>
        <div className="w-full h-1.5 bg-[#27272a] rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-emerald-500 to-blue-500 rounded-full transition-all"
            style={{ width: `${(fixedCnt / total) * 100}%` }}
          />
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search gaps, fixes, or descriptions…"
            className="w-full bg-[#18181b] border border-[#27272a] rounded-lg pl-8 pr-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-all font-mono"
          />
        </div>
        <div className="relative">
          <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-500" />
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as FilterStatus)}
            className="bg-[#18181b] border border-[#27272a] rounded-lg pl-7 pr-3 py-2 text-xs text-white focus:outline-none focus:border-blue-500 appearance-none font-mono cursor-pointer"
          >
            <option value="all">All Statuses</option>
            <option value="fixed">Fixed</option>
            <option value="in_progress">In Progress</option>
            <option value="pending">Pending</option>
            <option value="backlog">Backlog</option>
          </select>
        </div>
        <select
          value={priorityFilter}
          onChange={e => setPriorityFilter(e.target.value as FilterPriority)}
          className="bg-[#18181b] border border-[#27272a] rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-blue-500 appearance-none font-mono cursor-pointer"
        >
          <option value="all">All Priorities</option>
          <option value="critical">Critical (P0)</option>
          <option value="high">High (P1)</option>
          <option value="medium">Medium (P2)</option>
          <option value="low">Low (P3)</option>
        </select>
      </div>

      {/* Gaps table */}
      <div className="bg-[#18181b] border border-[#27272a] rounded-xl overflow-hidden shadow-xl">
        {/* Column headers */}
        <div className="hidden md:grid grid-cols-[180px_1fr_1fr_68px_76px_108px] gap-4 px-5 py-3 bg-[#111113] border-b border-[#27272a] text-[10px] font-mono font-semibold text-[#a1a1aa] uppercase tracking-wider">
          <span>Category / Gap</span>
          <span>Current State</span>
          <span>Fix / Solution</span>
          <span className="text-center">Priority</span>
          <span className="text-center">Effort</span>
          <span className="text-center">Status</span>
        </div>

        {filtered.length === 0 ? (
          <div className="py-16 text-center text-xs font-mono text-gray-500">
            No gaps match your current filters.
          </div>
        ) : (
          filtered.map((cat, ci) => {
            const Icon = cat.icon;
            const isCollapsed = collapsed.has(cat.id);
            const Chevron = isCollapsed ? ChevronRight : ChevronDown;
            return (
              <div key={cat.id} className={ci > 0 ? "border-t border-[#27272a]" : ""}>
                {/* Category row */}
                <button
                  onClick={() => toggle(cat.id)}
                  className="w-full flex items-center gap-2.5 px-5 py-3 bg-[#111113]/70 hover:bg-[#18181b] transition-colors text-left group"
                >
                  <Chevron className="w-3.5 h-3.5 text-gray-600 group-hover:text-gray-400 transition-colors flex-shrink-0" />
                  <Icon className={`w-4 h-4 ${cat.color} flex-shrink-0`} />
                  <span className="text-xs font-semibold text-white tracking-wide">{cat.label}</span>
                  <span className="ml-auto text-[10px] font-mono text-gray-500 pr-1">
                    {cat.gaps.length} gap{cat.gaps.length !== 1 ? "s" : ""}
                  </span>
                </button>

                {/* Gap rows */}
                {!isCollapsed && cat.gaps.map((gap, gi) => {
                  const pCfg = PRIORITY_CONFIG[gap.priority];
                  const sCfg = STATUS_CONFIG[gap.status];
                  const StatusIcon = sCfg.icon;
                  return (
                    <div
                      key={gap.id}
                      className="grid md:grid-cols-[180px_1fr_1fr_68px_76px_108px] gap-4 px-5 py-4 text-xs border-t border-[#27272a]/50 hover:bg-[#27272a]/20 transition-colors items-start"
                    >
                      <div className="flex flex-col justify-start pt-0.5 min-w-0">
                        <p className="font-semibold text-white leading-snug" title={gap.gap}>{gap.gap}</p>
                      </div>
                      <div className="min-w-0">
                        <p className="text-[11px] text-gray-400 leading-relaxed line-clamp-4">{gap.current}</p>
                      </div>
                      <div className="min-w-0">
                        <p className="text-[11px] text-gray-300 leading-relaxed line-clamp-4">{gap.fix}</p>
                      </div>
                      <div className="flex items-start justify-center pt-0.5">
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold font-mono ${pCfg.cls}`}>
                          {pCfg.label}
                        </span>
                      </div>
                      <div className="flex items-start justify-center pt-0.5">
                        <span className="text-[10px] font-mono text-gray-400 whitespace-nowrap">{gap.effort}</span>
                      </div>
                      <div className="flex items-start justify-center gap-1 pt-0.5">
                        <StatusIcon className={`w-3.5 h-3.5 ${sCfg.cls} flex-shrink-0 mt-0.5`} />
                        <span className={`text-[10px] font-mono ${sCfg.cls} whitespace-nowrap`}>{sCfg.label}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
