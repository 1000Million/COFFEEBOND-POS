import React from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Coffee, ShieldCheck } from 'lucide-react';

export default function PosMenuSettingsTab() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-black text-neutral-800">POS V2 Source</h2>
        <p className="text-sm text-neutral-500 mt-1">
          Coffee Bond POS now uses Menu Management V2 as the single billing source.
        </p>
      </div>

      <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6">
        <div className="flex flex-col md:flex-row md:items-start gap-4">
          <div className="w-12 h-12 bg-white text-emerald-700 rounded-xl border border-emerald-200 flex items-center justify-center shrink-0">
            <Coffee size={24} />
          </div>
          <div className="flex-1">
            <h3 className="text-xl font-black text-emerald-950">Finished Goods Menu is active for POS</h3>
            <p className="text-sm text-emerald-900 mt-2">
              Store billing uses active Finished Goods, linked BOM/prep recipes, storeStock, KOT prepStation routing, and order reports.
              The older development menu path is no longer exposed as a normal admin control.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-5">
              {[
                'Finished Goods Menu',
                'Recipe/BOM linked',
                'storeStock tracked',
                'KOT prepStation routed',
              ].map((label) => (
                <div key={label} className="flex items-center gap-2 bg-white/80 border border-emerald-100 rounded-xl px-3 py-2 text-sm font-bold text-emerald-900">
                  <CheckCircle2 size={16} className="text-emerald-600" />
                  {label}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Link
        to="/admin/pos-readiness"
        className="block bg-white border border-neutral-200 rounded-2xl p-5 hover:border-emerald-300 hover:shadow-md transition-all"
      >
        <div className="flex items-start gap-4">
          <div className="w-11 h-11 bg-emerald-50 text-emerald-700 rounded-xl flex items-center justify-center border border-emerald-200 shrink-0">
            <ShieldCheck size={22} />
          </div>
          <div>
            <h3 className="text-lg font-black text-neutral-900">Open POS Go-Live Readiness</h3>
            <p className="text-sm text-neutral-600 mt-1">
              Review all stores, BOM blockers, missing stock, zero stock warnings, KOT coverage, and the Uday Park espresso stock fix.
            </p>
          </div>
        </div>
      </Link>

      <div className="bg-neutral-50 border border-neutral-200 rounded-2xl p-5 text-sm text-neutral-600">
        <p className="font-black text-neutral-800 mb-1">Developer note</p>
        <p>
          The older source switching controls remain out of normal admin navigation and should be removed after POS V2 live testing is complete.
        </p>
      </div>
    </div>
  );
}
