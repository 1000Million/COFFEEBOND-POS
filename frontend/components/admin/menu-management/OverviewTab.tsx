import React from "react";
import {
  Package,
  ClipboardList,
  Coffee,
  Store,
  LayoutGrid,
  TrendingUp,
  AlertTriangle,
  Blocks,
} from "lucide-react";

interface OverviewTabProps {
  onNavigate: (
    tab:
      | "raw"
      | "prep"
      | "prep-production"
      | "finished"
      | "pos"
      | "stock"
      | "costing"
      | "migration",
  ) => void;
}

export default function OverviewTab({ onNavigate }: OverviewTabProps) {
  const cards = [
    {
      id: "raw",
      title: "Raw Ingredients",
      description:
        "Base ingredients purchased for recipes, packaging, and production.",
      icon: Package,
      color: "bg-emerald-50 text-emerald-700",
      status: "Active",
    },
    {
      id: "prep",
      title: "Batch Prep / Components",
      description:
        "Create batch-produced components such as cold foam, sauces, dips, and concentrates.",
      icon: ClipboardList,
      color: "bg-indigo-50 text-indigo-700",
      status: "Active",
    },
    {
      id: "finished",
      title: "Sellable Items",
      description:
        "Customer-facing products sold on the POS. Each item can be made to order, assembled to order, bought and sold, or no-stock.",
      icon: Coffee,
      color: "bg-fuchsia-50 text-fuchsia-700",
      status: "Active",
    },
    {
      id: "stock",
      title: "Store Stock",
      description:
        "Track physical stock for raw ingredients, prep items, bought components, packaging, and sellable products.",
      icon: Store,
      color: "bg-amber-50 text-amber-700",
      status: "Active",
    },
    {
      id: "pos",
      title: "POS Rollout",
      description:
        "Control which store uses the live Menu Management POS source.",
      icon: LayoutGrid,
      color: "bg-blue-50 text-blue-700",
      status: "Active",
    },
    {
      id: "costing",
      title: "Costing Dashboard",
      description: "Recipe cost, COGS, and gross margin analysis.",
      icon: TrendingUp,
      color: "bg-neutral-100 text-neutral-600",
      status: "Pending",
    },
    {
      id: "migration",
      title: "Migration Preview",
      description: "Review data consistency before expanding rollout.",
      icon: AlertTriangle,
      color: "bg-rose-50 text-rose-700",
      status: "Review",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h2 className="text-2xl font-black text-neutral-800">
          System Overview
        </h2>
        <p className="text-sm text-neutral-500 mt-1">
          Select a module to manage its data or configuration.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {cards.map((card) => (
          <div
            key={card.id}
            onClick={() => onNavigate(card.id as any)}
            className="bg-white border text-left border-neutral-200 rounded-2xl p-6 shadow-sm hover:shadow-md hover:border-[#5c4033]/30 transition-all cursor-pointer flex flex-col h-full"
          >
            <div className="flex items-start justify-between mb-4">
              <div className={`p-3 rounded-xl ${card.color}`}>
                <card.icon size={24} />
              </div>
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 bg-neutral-100 text-neutral-600 rounded">
                {card.status}
              </span>
            </div>
            <h3 className="text-lg font-bold text-neutral-800 mb-2">
              {card.title}
            </h3>
            <p className="text-sm text-neutral-500 flex-grow">
              {card.description}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
