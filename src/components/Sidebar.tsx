import React from "react";
import {
  LayoutDashboard,
  Cpu, 
  Share2, 
  Database, 
  BarChart3, 
  ShieldCheck, 
  Activity,
  LogOut,
  AlertTriangle
} from "lucide-react";
import { ActiveView } from "../types";

type MenuItem = {
  id: ActiveView;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

interface SidebarProps {
  activeView: ActiveView;
  setActiveView: (view: ActiveView) => void;
  apiKeyLoaded: boolean;
  user: any;
  onLogout: () => void;
}

export default function Sidebar({ activeView, setActiveView, apiKeyLoaded, user, onLogout }: SidebarProps) {
  const menuItems: MenuItem[] = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "refinery", label: "Data Refinery", icon: Cpu },
    { id: "connectors", label: "Connectors", icon: Share2 },
    { id: "vector", label: "Vector DB Sync", icon: Database },
    { id: "analytics", label: "Analytics", icon: BarChart3 },
    { id: "gaps", label: "Gaps Tracker", icon: AlertTriangle },
    { id: "pricing", label: "Upgrade Plan", icon: Activity },
  ];

  if (user && user.role === "admin") {
    menuItems.push({ id: "admin", label: "Admin Panel", icon: ShieldCheck });
  }

  return (
    <aside id="sidebar-nav" className="w-64 bg-[#111113] border-r border-[#27272a] flex flex-col justify-between h-screen sticky top-0">
      {/* Brand Header */}
      <div>
        <div className="p-6 flex items-center gap-3 border-b border-[#27272a]">
          <div className="w-8 h-8 rounded-lg bg-[#3b82f6]/10 border border-[#3b82f6]/30 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-[#3b82f6] animate-pulse" />
          </div>
          <div>
            <h1 className="text-sm font-display font-semibold text-white tracking-wide leading-none">Clean Data Hub</h1>
            <span className="text-[10px] font-mono text-gray-500">v1.1 Enterprise</span>
          </div>
        </div>

        {/* Navigation List */}
        <nav className="p-4 space-y-1.5">
          <p className="px-3 text-[10px] font-mono font-medium text-[#a1a1aa] uppercase tracking-wider mb-2">Workspace</p>
          {menuItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveView(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-medium transition-all ${
                  isActive 
                    ? "bg-[#18181b] text-[#3b82f6] border-l-2 border-[#3b82f6] font-semibold" 
                    : "text-[#a1a1aa] hover:bg-[#18181b] hover:text-white"
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? "text-[#3b82f6]" : "text-gray-500"}`} />
                {item.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* System Status Indicators & User Profile */}
      <div className="p-4 border-t border-[#27272a] bg-[#0A0A0B] space-y-4">
        {/* User Profile Info & Logout */}
        {user && (
          <div className="flex items-center justify-between p-2.5 bg-[#18181b] rounded-lg border border-[#27272a]">
            <div className="overflow-hidden pr-2">
              <p className="text-[11px] font-medium text-white truncate" title={user.email}>{user.email}</p>
              <p className="text-[9px] font-mono text-gray-500 truncate" title={user.tenantId}>Org: {user.tenantId}</p>
            </div>
            <button
              onClick={onLogout}
              title="Sign Out"
              className="p-1.5 rounded text-gray-400 hover:text-red-400 hover:bg-red-500/10 active:scale-95 transition-all flex-shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-[#a1a1aa] flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#10b981] inline-block animate-ping"></span>
            PII Shield: ACTIVE
          </span>
          <span className="text-[10px] font-mono text-gray-500">RLS Isolated</span>
        </div>

        <div className="p-3 bg-[#18181b] rounded-lg border border-[#27272a] space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-[#a1a1aa] font-medium">Gemini Backend</span>
            <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
              apiKeyLoaded 
                ? "bg-[#3b82f6]/10 text-[#3b82f6] border border-[#3b82f6]/20" 
                : "bg-[#f59e0b]/10 text-[#f59e0b] border border-[#f59e0b]/20"
            }`}>
              {apiKeyLoaded ? "Live API" : "Simulated"}
            </span>
          </div>
          <p className="text-[9px] text-gray-500 leading-normal">
            {apiKeyLoaded 
              ? "Running server-side Gemini 3.5-flash for layout processing." 
              : "Running in offline mode. Add GEMINI_API_KEY to activate live AI refining."}
          </p>
        </div>
      </div>
    </aside>
  );
}
