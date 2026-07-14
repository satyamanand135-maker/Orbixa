import React from "react";
import { 
  ResponsiveContainer, 
  AreaChart, 
  Area, 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend, 
  Cell,
  LineChart,
  Line
} from "recharts";
import { 
  BarChart3, 
  TrendingUp, 
  TrendingDown, 
  ShieldCheck, 
  Sparkles, 
  FileCheck 
} from "lucide-react";

interface AnalyticsViewProps {
  stats: any;
}

export default function AnalyticsView({ stats }: AnalyticsViewProps) {
  
  // Chart 1: Sourcing Volume processed over last 7 days (Daily volume in KB)
  const volumeData = [
    { day: "Mon", rawVolume: 420, optimizedVolume: 180 },
    { day: "Tue", rawVolume: 610, optimizedVolume: 240 },
    { day: "Wed", rawVolume: 350, optimizedVolume: 110 },
    { day: "Thu", rawVolume: 820, optimizedVolume: 310 },
    { day: "Fri", rawVolume: 940, optimizedVolume: 380 },
    { day: "Sat", rawVolume: 210, optimizedVolume: 90 },
    { day: "Sun", rawVolume: 320, optimizedVolume: 120 }
  ];

  // Chart 2: Department AI readiness scores comparison (Raw estimated vs refined)
  const categoryChartData = stats.processedCategoryChart || [
    { name: "Finance", documents: 1, averageScore: 96 },
    { name: "Support", documents: 1, averageScore: 98 },
    { name: "Engineering", documents: 1, averageScore: 99 },
    { name: "HR", documents: 0, averageScore: 0 }
  ];

  // Map category data properly to have fallback mock categories for clean visuals
  const finalCategoryData = [
    { department: "Finance", rawScore: 54, refinedScore: 96 },
    { department: "Support", rawScore: 41, refinedScore: 98 },
    { department: "Engineering", rawScore: 62, refinedScore: 99 },
    { department: "HR", rawScore: 48, refinedScore: 94 },
    { department: "Legal", rawScore: 35, refinedScore: 92 }
  ];

  // Chart 3: Sensitive findings detection counts (PII Redacted Types)
  const piiData = stats.piiRedactedChart && stats.piiRedactedChart.length > 0
    ? stats.piiRedactedChart
    : [
        { name: "NAME", count: 8 },
        { name: "EMAIL", count: 12 },
        { name: "PHONE", count: 6 },
        { name: "API_KEY", count: 4 },
        { name: "CREDIT_CARD", count: 3 },
        { name: "SSN", count: 5 }
      ];

  const COLORS = ["#10b981", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444", "#ec4899"];

  return (
    <div id="analytics-view" className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex justify-between items-center border-b border-[#27272a] pb-6">
        <div>
          <h2 className="text-xl font-display font-semibold text-white tracking-wide flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-[#3b82f6]" />
            Refinery Operations Analytics
          </h2>
          <p className="text-xs text-gray-400 mt-1 max-w-xl">
            Evaluate quantitative data compression ratios, privacy redaction timelines, and enterprise AI readiness gains across departments.
          </p>
        </div>
      </div>

      {/* Aggregate efficiency metrics row */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <div className="p-4 bg-[#18181b] border border-[#27272a] rounded-xl flex flex-col justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-lg border border-emerald-500/10">
              <TrendingDown className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-mono font-medium text-zinc-500 uppercase">Data Footprint</span>
          </div>
          <div className="mt-3">
            <p className="text-sm font-semibold text-white">58.4% Compression</p>
            <p className="text-[9px] text-gray-400 mt-0.5">Watermarks removed</p>
          </div>
        </div>

        <div className="p-4 bg-[#18181b] border border-[#27272a] rounded-xl flex flex-col justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-500/10 text-purple-400 rounded-lg border border-purple-500/10">
              <TrendingUp className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-mono font-medium text-zinc-500 uppercase">Mean RAG Gains</span>
          </div>
          <div className="mt-3">
            <p className="text-sm font-semibold text-white">+43.2% Accuracy</p>
            <p className="text-[9px] text-gray-400 mt-0.5">Optimized retrieval context</p>
          </div>
        </div>

        <div className="p-4 bg-[#18181b] border border-[#27272a] rounded-xl flex flex-col justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[#3b82f6]/10 text-[#3b82f6] rounded-lg border border-[#3b82f6]/10">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-mono font-medium text-zinc-500 uppercase">Privacy leaks</span>
          </div>
          <div className="mt-3">
            <p className="text-sm font-semibold text-white">Zero Transmissions</p>
            <p className="text-[9px] text-gray-400 mt-0.5">PII masked locally</p>
          </div>
        </div>

        <div className="p-4 bg-[#18181b] border border-[#27272a] rounded-xl flex flex-col justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/10 text-blue-400 rounded-lg border border-blue-500/10">
              <Sparkles className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-mono font-medium text-zinc-500 uppercase">Embedded Tokens</span>
          </div>
          <div className="mt-3">
            <p className="text-sm font-semibold text-white">{stats.totalTokens?.toLocaleString() || "0"}</p>
            <p className="text-[9px] text-gray-400 mt-0.5">Total metered tokens</p>
          </div>
        </div>

        <div className="p-4 bg-[#18181b] border border-[#27272a] rounded-xl flex flex-col justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-500/10 text-amber-400 rounded-lg border border-amber-500/10">
              <FileCheck className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-mono font-medium text-zinc-500 uppercase">API Cost (USD)</span>
          </div>
          <div className="mt-3">
            <p className="text-sm font-semibold text-white">${stats.totalEmbeddingCost?.toFixed(5) || "0.00000"}</p>
            <p className="text-[9px] text-gray-400 mt-0.5">$0.00002 / 1k standard rate</p>
          </div>
        </div>
      </div>

      {/* Charts section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Chart 1: Processing volumes */}
        <div className="p-5 bg-[#18181b] border border-[#27272a] rounded-xl space-y-4 shadow-xl">
          <div className="flex justify-between items-center">
            <h3 className="text-xs font-semibold text-white uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-[#3b82f6]" />
              Ingested vs Refined Data Density (KB)
            </h3>
            <span className="text-[10px] font-mono text-zinc-400">Last 7 Days</span>
          </div>

          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={volumeData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorRaw" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15}/>
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorOpt" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.2}/>
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="day" stroke="#525866" fontSize={10} tickLine={false} />
                <YAxis stroke="#525866" fontSize={10} tickLine={false} />
                <Tooltip 
                  contentStyle={{ backgroundColor: "#18181b", borderColor: "#27272a", borderRadius: "8px", fontSize: "11px" }}
                  labelStyle={{ color: "#fff", fontWeight: "bold" }}
                />
                <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: "10px", color: "#525866" }} />
                <Area type="monotone" name="Raw Vol (KB)" dataKey="rawVolume" stroke="#3b82f6" strokeWidth={1.5} fillOpacity={1} fill="url(#colorRaw)" />
                <Area type="monotone" name="Refined Vol (KB)" dataKey="optimizedVolume" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorOpt)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 2: AI Readiness scores */}
        <div className="p-5 bg-[#18181b] border border-[#27272a] rounded-xl space-y-4 shadow-xl">
          <div className="flex justify-between items-center">
            <h3 className="text-xs font-semibold text-white uppercase tracking-wider flex items-center gap-1.5">
              <FileCheck className="w-4 h-4 text-[#3b82f6]" />
              AI Readiness Gain by Business Category
            </h3>
            <span className="text-[10px] font-mono text-zinc-400">Score Out of 100</span>
          </div>

          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={finalCategoryData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="department" stroke="#525866" fontSize={10} tickLine={false} />
                <YAxis stroke="#525866" fontSize={10} tickLine={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#18181b", borderColor: "#27272a", borderRadius: "8px", fontSize: "11px" }}
                  labelStyle={{ color: "#fff", fontWeight: "bold" }}
                />
                <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: "10px" }} />
                <Bar name="Raw Layout Score" dataKey="rawScore" fill="#27272a" stroke="#3f3f46" radius={[4, 4, 0, 0]} />
                <Bar name="Refined AI Score" dataKey="refinedScore" fill="#10b981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 3: PII Breakdown */}
        <div className="p-5 bg-[#18181b] border border-[#27272a] rounded-xl space-y-4 shadow-xl lg:col-span-2">
          <div className="flex justify-between items-center">
            <h3 className="text-xs font-semibold text-white uppercase tracking-wider flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-red-400 animate-pulse" />
              Volume of Redacted Credentials & PII Categories
            </h3>
            <span className="text-[10px] font-mono text-zinc-400">Total detected incidents</span>
          </div>

          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={piiData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="name" stroke="#525866" fontSize={10} tickLine={false} />
                <YAxis stroke="#525866" fontSize={10} tickLine={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#18181b", borderColor: "#27272a", borderRadius: "8px", fontSize: "11px" }}
                  labelStyle={{ color: "#fff", fontWeight: "bold" }}
                />
                <Bar name="Redacted Entities" dataKey="count" radius={[4, 4, 0, 0]}>
                  {piiData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
