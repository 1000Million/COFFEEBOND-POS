import React, { useState } from "react";
import {
  Package,
  ClipboardList,
  Coffee,
  LayoutGrid,
  Store,
  TrendingUp,
  AlertTriangle,
  Plus,
  ChevronDown,
  List,
  Blocks,
} from "lucide-react";
import RawIngredientsTab from "../../components/admin/menu-management/RawIngredientsTab";
import StoreStockTab from "../../components/admin/menu-management/StoreStockTab";
import PrepItemsTab from "../../components/admin/menu-management/PrepItemsTab";
import PrepProductionTab from "../../components/admin/menu-management/PrepProductionTab";
import FinishedGoodsTab from "../../components/admin/menu-management/FinishedGoodsTab";
import PosMenuSettingsTab from "../../components/admin/menu-management/PosMenuSettingsTab";
import MigrationPreviewTab from "../../components/admin/menu-management/MigrationPreviewTab";
import OverviewTab from "../../components/admin/menu-management/OverviewTab";

type TabId =
  | "overview"
  | "raw"
  | "prep"
  | "prep-production"
  | "finished"
  | "stock"
  | "pos"
  | "costing"
  | "migration";

export default function MenuManagementHub() {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const tabs: { id: TabId; label: string; icon: React.ElementType }[] = [
    { id: "overview", label: "Overview", icon: LayoutGrid },
    { id: "raw", label: "Raw Ingredients", icon: Package },
    { id: "prep", label: "Batch Prep / Components", icon: ClipboardList },
    { id: "prep-production", label: "Prep Production", icon: ClipboardList },
    { id: "finished", label: "Sellable Items", icon: Coffee },
    { id: "stock", label: "Store Stock", icon: Store },
    { id: "pos", label: "POS Rollout", icon: LayoutGrid },
    { id: "costing", label: "Costing Dashboard", icon: TrendingUp },
    { id: "migration", label: "Migration Preview", icon: AlertTriangle },
  ];

  const activeTabDetails = tabs.find((t) => t.id === activeTab);

  return (
    <div className="w-full min-w-0 max-w-[1280px] mx-auto p-3 sm:p-5 lg:p-8 space-y-6 lg:space-y-8">
      <div className="menu-management-shell grid grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)] gap-6 items-start w-full max-w-[1280px] mx-auto min-w-0">
        {/* Left Sidebar (Desktop) / Dropdown (Mobile) */}
        <aside className="menu-management-sidebar space-y-4 lg:w-[240px] lg:min-w-[240px] lg:sticky lg:top-[96px]">
          <div className="block lg:hidden">
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="w-full bg-white border border-neutral-200 rounded-xl p-4 flex items-center justify-between shadow-sm"
            >
              <div className="flex items-center gap-3">
                {activeTabDetails && (
                  <activeTabDetails.icon size={20} className="text-[#5c4033]" />
                )}
                <span className="font-bold text-[#5c4033]">
                  {activeTabDetails?.label}
                </span>
              </div>
              <ChevronDown
                size={20}
                className={`text-neutral-500 transition-transform ${mobileMenuOpen ? "rotate-180" : ""}`}
              />
            </button>
            {mobileMenuOpen && (
              <div className="absolute left-4 right-4 mt-2 bg-white border border-neutral-200 rounded-xl shadow-lg z-50 p-2 space-y-1">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => {
                      setActiveTab(tab.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 p-3 text-sm font-semibold rounded-lg transition-colors ${activeTab === tab.id ? "bg-[#5c4033] text-white" : "text-neutral-600 hover:bg-neutral-50"}`}
                  >
                    <tab.icon size={18} />
                    {tab.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="hidden lg:flex flex-col bg-white border border-neutral-200 rounded-2xl p-4 shadow-sm space-y-1">
            <div className="mb-4 px-3 uppercase tracking-wider text-[10px] font-black text-neutral-400">
              Modules
            </div>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-sm font-bold rounded-xl transition-all ${activeTab === tab.id ? "bg-[#5c4033] text-white shadow-sm" : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"}`}
              >
                <tab.icon
                  size={18}
                  className={
                    activeTab === tab.id ? "text-white" : "text-neutral-400"
                  }
                />
                {tab.label}
              </button>
            ))}
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="menu-management-content min-w-0 w-full max-w-full overflow-hidden min-h-[500px]">
          {activeTab === "overview" ? (
            <OverviewTab onNavigate={setActiveTab as any} />
          ) : activeTab === "raw" ? (
            <RawIngredientsTab />
          ) : activeTab === "prep" ? (
            <PrepItemsTab />
          ) : activeTab === "prep-production" ? (
            <PrepProductionTab />
          ) : activeTab === "finished" ? (
            <FinishedGoodsTab />
          ) : activeTab === "stock" ? (
            <StoreStockTab />
          ) : activeTab === "pos" ? (
            <PosMenuSettingsTab />
          ) : activeTab === "costing" ? (
            <div className="flex flex-col items-center justify-center p-12 bg-white border border-dashed border-neutral-300 rounded-2xl text-center">
              <TrendingUp
                size={48}
                className="mb-4 opacity-30 text-[#5c4033]"
              />
              <p className="font-bold text-lg text-neutral-600 mb-2">
                Costing Dashboard
              </p>
              <p className="text-sm text-neutral-500 max-w-md">
                Analyze recipe costs, margins, and yield efficiency here. Coming
                soon.
              </p>
            </div>
          ) : activeTab === "migration" ? (
            <MigrationPreviewTab />
          ) : null}
        </main>
      </div>
    </div>
  );
}
