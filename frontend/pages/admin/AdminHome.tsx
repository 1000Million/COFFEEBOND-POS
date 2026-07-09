import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { 
  Store, Tags, MenuSquare, DatabaseZap, Package, Database, 
  BookOpen, FileSpreadsheet, Calculator, LineChart, Coffee, 
  ChefHat, Bell, ChevronDown, ChevronRight, Users, FileCheck2, FileSearch, ShieldCheck, ShoppingBag, ListChecks
} from 'lucide-react';
import { motion } from 'motion/react';

export default function AdminHome() {
  const [showHistoricalTools, setShowHistoricalTools] = useState(false);

  const containerVariants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.05
      }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 15, scale: 0.98 },
    show: { opacity: 1, y: 0, scale: 1, transition: { type: "spring" as const, stiffness: 100, damping: 15 } }
  };

  return (
    <div className="max-w-4xl mx-auto w-full min-w-0 pb-20">
      <motion.h2 
        initial={{ opacity: 0, x: -10 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.4 }}
        className="text-3xl font-black text-[#5c4033] mb-8"
      >
        Admin Dashboard
      </motion.h2>
      
      {/* Hero Card: Menu Management */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring" as const, stiffness: 100, damping: 15, delay: 0.1 }}
      >
        <Link to="/admin/menu-management" className="group block mb-10 bg-white p-6 md:p-8 rounded-3xl shadow-sm border border-amber-300 hover:border-amber-500 hover:shadow-lg transition-all relative overflow-hidden">
          <div className="absolute top-0 right-0 bg-amber-100 text-amber-800 text-xs font-bold px-3 py-1 rounded-bl-xl border-b border-l border-amber-200">
            New operating system
          </div>
          <div className="flex min-w-0 items-start gap-4 md:gap-6">
            <div className="w-16 h-16 bg-amber-50 text-amber-600 rounded-2xl flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
              <DatabaseZap size={32} />
            </div>
            <div>
              <h3 className="font-bold text-2xl text-neutral-800 mb-2 group-hover:text-amber-800 transition-colors">Menu Management</h3>
              <p className="text-neutral-600">Ingredients, BOM, Finished Goods, Stock, Costing, and POS V2 readiness.</p>
            </div>
          </div>
        </Link>
      </motion.div>

      {/* Core Operations */}
      <div className="mb-10">
        <h3 className="text-xl font-bold text-neutral-800 mb-4 px-2">Core Operations</h3>
        <motion.div 
          variants={containerVariants}
          initial="hidden"
          animate="show"
          className="grid grid-cols-1 md:grid-cols-2 gap-4"
        >
          <motion.div variants={itemVariants} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="cursor-pointer">
            <Link to="/admin/stores" className="bg-white p-5 rounded-2xl shadow-sm border border-neutral-100 hover:border-[#5c4033]/30 hover:shadow-md transition-all flex items-center gap-4 h-full">
              <div className="w-10 h-10 bg-neutral-100 text-[#5c4033] rounded-xl flex items-center justify-center shrink-0">
                <Store size={20} />
              </div>
              <div>
                <h4 className="font-bold text-neutral-800">Stores</h4>
              </div>
            </Link>
          </motion.div>

          <motion.div variants={itemVariants} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="cursor-pointer">
            <Link to="/admin/staff" className="bg-white p-5 rounded-2xl shadow-sm border border-neutral-100 hover:border-[#5c4033]/30 hover:shadow-md transition-all flex items-center gap-4 h-full">
              <div className="w-10 h-10 bg-neutral-100 text-[#5c4033] rounded-xl flex items-center justify-center shrink-0">
                <Users size={20} />
              </div>
              <div>
                <h4 className="font-bold text-neutral-800">Staff Management</h4>
              </div>
            </Link>
          </motion.div>

          <motion.div variants={itemVariants} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="cursor-pointer">
            <Link to="/pos" className="bg-white p-5 rounded-2xl shadow-sm border border-neutral-100 hover:border-[#5c4033]/30 hover:shadow-md transition-all flex items-center gap-4 h-full">
              <div className="w-10 h-10 bg-neutral-100 text-[#5c4033] rounded-xl flex items-center justify-center shrink-0">
                <Calculator size={20} />
              </div>
              <div>
                <h4 className="font-bold text-neutral-800">POS</h4>
              </div>
            </Link>
          </motion.div>

          <motion.div variants={itemVariants} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="cursor-pointer">
            <Link to="/inventory/control" className="bg-white p-5 rounded-2xl shadow-sm border border-neutral-100 hover:border-[#5c4033]/30 hover:shadow-md transition-all flex items-center gap-4 h-full">
              <div className="w-10 h-10 bg-neutral-100 text-[#5c4033] rounded-xl flex items-center justify-center shrink-0">
                <Package size={20} />
              </div>
              <div>
                <h4 className="font-bold text-neutral-800">Inventory Control</h4>
                <p className="text-xs text-neutral-500">Sales-first COGS and stock audit</p>
              </div>
            </Link>
          </motion.div>

          <motion.div variants={itemVariants} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="cursor-pointer">
            <Link to="/pos/incoming-orders" className="bg-white p-5 rounded-2xl shadow-sm border border-neutral-100 hover:border-[#5c4033]/30 hover:shadow-md transition-all flex items-center gap-4 h-full">
              <div className="w-10 h-10 bg-neutral-100 text-[#5c4033] rounded-xl flex items-center justify-center shrink-0">
                <ShoppingBag size={20} />
              </div>
              <div>
                <h4 className="font-bold text-neutral-800">Online Orders</h4>
                <p className="text-xs text-neutral-500">Accept or reject customer requests</p>
              </div>
            </Link>
          </motion.div>

          <motion.div variants={itemVariants} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="cursor-pointer">
            <Link to="/pos/running-orders" className="bg-white p-5 rounded-2xl shadow-sm border border-neutral-100 hover:border-[#5c4033]/30 hover:shadow-md transition-all flex items-center gap-4 h-full">
              <div className="w-10 h-10 bg-neutral-100 text-[#5c4033] rounded-xl flex items-center justify-center shrink-0">
                <ListChecks size={20} />
              </div>
              <div>
                <h4 className="font-bold text-neutral-800">Running Orders</h4>
                <p className="text-xs text-neutral-500">Live order, KOT, and payment board</p>
              </div>
            </Link>
          </motion.div>

          <motion.div variants={itemVariants} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="cursor-pointer">
            <Link to="/reports" className="bg-white p-5 rounded-2xl shadow-sm border border-neutral-100 hover:border-[#5c4033]/30 hover:shadow-md transition-all flex items-center gap-4 h-full">
              <div className="w-10 h-10 bg-neutral-100 text-[#5c4033] rounded-xl flex items-center justify-center shrink-0">
                <LineChart size={20} />
              </div>
              <div>
                <h4 className="font-bold text-neutral-800">Reports</h4>
              </div>
            </Link>
          </motion.div>

          <motion.div variants={itemVariants} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="cursor-pointer">
            <Link to="/reports/day-close" className="bg-white p-5 rounded-2xl shadow-sm border border-neutral-100 hover:border-[#5c4033]/30 hover:shadow-md transition-all flex items-center gap-4 h-full">
              <div className="w-10 h-10 bg-neutral-100 text-[#5c4033] rounded-xl flex items-center justify-center shrink-0">
                <FileCheck2 size={20} />
              </div>
              <div>
                <h4 className="font-bold text-neutral-800">Day Close</h4>
                <p className="text-xs text-neutral-500">Cashier closing and payment reconciliation</p>
              </div>
            </Link>
          </motion.div>

          <motion.div variants={itemVariants} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="cursor-pointer">
            <Link to="/reports/audit-control" className="bg-blue-50 p-5 rounded-2xl shadow-sm border border-blue-200 hover:border-blue-400 hover:shadow-md transition-all flex items-center gap-4 h-full">
              <div className="w-10 h-10 bg-white text-blue-700 rounded-xl flex items-center justify-center shrink-0 border border-blue-200">
                <FileSearch size={20} />
              </div>
              <div>
                <h4 className="font-bold text-neutral-800">Audit Control</h4>
                <p className="text-xs text-neutral-500">Owner checks after day close</p>
              </div>
            </Link>
          </motion.div>

          <motion.div variants={itemVariants} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="cursor-pointer">
            <Link to="/admin/pos-readiness" className="bg-emerald-50 p-5 rounded-2xl shadow-sm border border-emerald-200 hover:border-emerald-400 hover:shadow-md transition-all flex items-center gap-4 h-full">
              <div className="w-10 h-10 bg-white text-emerald-700 rounded-xl flex items-center justify-center shrink-0 border border-emerald-200">
                <ShieldCheck size={20} />
              </div>
              <div>
                <h4 className="font-bold text-neutral-800">POS Readiness</h4>
                <p className="text-xs text-neutral-500">Go-live blockers and stock fixes</p>
              </div>
            </Link>
          </motion.div>

          <motion.div variants={itemVariants} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="cursor-pointer">
            <Link to="/kot/barista" className="bg-white p-5 rounded-2xl shadow-sm border border-neutral-100 hover:border-[#5c4033]/30 hover:shadow-md transition-all flex items-center gap-4 h-full">
              <div className="w-10 h-10 bg-neutral-100 text-[#5c4033] rounded-xl flex items-center justify-center shrink-0">
                <Coffee size={20} />
              </div>
              <div>
                <h4 className="font-bold text-neutral-800">Barista KOT</h4>
              </div>
            </Link>
          </motion.div>

          <motion.div variants={itemVariants} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="cursor-pointer">
            <Link to="/kot/kitchen" className="bg-white p-5 rounded-2xl shadow-sm border border-neutral-100 hover:border-[#5c4033]/30 hover:shadow-md transition-all flex items-center gap-4 h-full">
              <div className="w-10 h-10 bg-neutral-100 text-[#5c4033] rounded-xl flex items-center justify-center shrink-0">
                <ChefHat size={20} />
              </div>
              <div>
                <h4 className="font-bold text-neutral-800">Kitchen KOT</h4>
              </div>
            </Link>
          </motion.div>

          <motion.div variants={itemVariants} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="cursor-pointer">
            <Link to="/kot/ready" className="bg-white p-5 rounded-2xl shadow-sm border border-neutral-100 hover:border-[#5c4033]/30 hover:shadow-md transition-all flex items-center gap-4 h-full">
              <div className="w-10 h-10 bg-neutral-100 text-[#5c4033] rounded-xl flex items-center justify-center shrink-0">
                <Bell size={20} />
              </div>
              <div>
                <h4 className="font-bold text-neutral-800">Ready to Serve</h4>
              </div>
            </Link>
          </motion.div>
        </motion.div>
      </div>

      {/* Historical Setup Tools Overlay */}
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="bg-neutral-50 border border-neutral-200 rounded-3xl p-6"
      >
        <button 
          onClick={() => setShowHistoricalTools(!showHistoricalTools)}
          className="flex items-center justify-between w-full group cursor-pointer outline-none"
        >
          <div className="text-left font-sans">
            <h3 className="text-xl font-bold text-neutral-800 flex items-center gap-2 group-hover:text-[#5c4033] transition-colors">
              Historical Setup Tools
              {showHistoricalTools ? <ChevronDown size={20} className="text-neutral-400" /> : <ChevronRight size={20} className="text-neutral-400" />}
            </h3>
            <p className="text-sm text-neutral-500 mt-1 block">Older setup and import utilities remain available for review while POS V2 is tested.</p>
          </div>
        </button>

        {showHistoricalTools && (
          <motion.div 
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            transition={{ ease: "easeInOut", duration: 0.3 }}
            className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6 pt-6 border-t border-neutral-200 border-dashed overflow-hidden"
          >
            <Link to="/admin/categories" className="bg-white p-4 rounded-xl shadow-sm border border-neutral-100 hover:border-neutral-300 transition-all flex items-center gap-3">
              <div className="w-8 h-8 bg-neutral-100 text-neutral-600 rounded-lg flex items-center justify-center shrink-0">
                <Tags size={16} />
              </div>
              <div>
                <h4 className="font-bold text-sm text-neutral-800">Categories</h4>
              </div>
            </Link>
            
            <Link to="/admin/menu" className="bg-white p-4 rounded-xl shadow-sm border border-neutral-100 hover:border-neutral-300 transition-all flex items-center gap-3">
              <div className="w-8 h-8 bg-neutral-100 text-neutral-600 rounded-lg flex items-center justify-center shrink-0">
                <MenuSquare size={16} />
              </div>
              <div>
                <h4 className="font-bold text-sm text-neutral-800">Menu Items</h4>
              </div>
            </Link>
            
            <Link to="/admin/inventory" className="bg-white p-4 rounded-xl shadow-sm border border-neutral-100 hover:border-neutral-300 transition-all flex items-center gap-3">
              <div className="w-8 h-8 bg-neutral-100 text-neutral-600 rounded-lg flex items-center justify-center shrink-0">
                <Package size={16} />
              </div>
              <div>
                <h4 className="font-bold text-sm text-neutral-800">Global Inventory</h4>
              </div>
            </Link>

            <Link to="/admin/store-inventory" className="bg-white p-4 rounded-xl shadow-sm border border-neutral-100 hover:border-neutral-300 transition-all flex items-center gap-3">
              <div className="w-8 h-8 bg-neutral-100 text-neutral-600 rounded-lg flex items-center justify-center shrink-0">
                <Database size={16} />
              </div>
              <div>
                <h4 className="font-bold text-sm text-neutral-800">Store Inventory</h4>
              </div>
            </Link>

            <Link to="/admin/recipes" className="bg-white p-4 rounded-xl shadow-sm border border-neutral-100 hover:border-neutral-300 transition-all flex items-center gap-3">
              <div className="w-8 h-8 bg-neutral-100 text-neutral-600 rounded-lg flex items-center justify-center shrink-0">
                <BookOpen size={16} />
              </div>
              <div>
                <h4 className="font-bold text-sm text-neutral-800">Recipes</h4>
              </div>
            </Link>

            <Link to="/admin/seed" className="bg-white p-4 rounded-xl shadow-sm border border-neutral-100 hover:border-neutral-300 transition-all flex items-center gap-3">
              <div className="w-8 h-8 bg-neutral-100 text-neutral-600 rounded-lg flex items-center justify-center shrink-0">
                <DatabaseZap size={16} />
              </div>
              <div>
                <h4 className="font-bold text-sm text-neutral-800">System Seed</h4>
              </div>
            </Link>

            <Link to="/admin/data" className="bg-white p-4 rounded-xl shadow-sm border border-neutral-100 hover:border-neutral-300 transition-all flex items-center gap-3">
              <div className="w-8 h-8 bg-neutral-100 text-neutral-600 rounded-lg flex items-center justify-center shrink-0">
                <FileSpreadsheet size={16} />
              </div>
              <div>
                <h4 className="font-bold text-sm text-neutral-800">Excel Data Import/Export</h4>
              </div>
            </Link>

            <Link to="/admin/phase-7a-validation" className="bg-white p-4 rounded-xl shadow-sm border border-amber-200 hover:border-amber-400 transition-all flex items-center gap-3">
              <div className="w-8 h-8 bg-amber-50 text-amber-700 rounded-lg flex items-center justify-center shrink-0">
                <FileCheck2 size={16} />
              </div>
              <div>
                <h4 className="font-bold text-sm text-neutral-800">Phase 7A Validation</h4>
                <p className="text-xs text-neutral-500">Readiness check only</p>
              </div>
            </Link>

            <Link to="/admin/phase-7h-stock-costing" className="bg-white p-4 rounded-xl shadow-sm border border-amber-200 hover:border-amber-400 transition-all flex items-center gap-3">
              <div className="w-8 h-8 bg-amber-50 text-amber-700 rounded-lg flex items-center justify-center shrink-0">
                <FileSpreadsheet size={16} />
              </div>
              <div>
                <h4 className="font-bold text-sm text-neutral-800">Phase 7H Stock + Costing</h4>
                <p className="text-xs text-neutral-500">Costs and opening stock</p>
              </div>
            </Link>

            <Link to="/admin/phase-7i-bom-alias-correction" className="bg-white p-4 rounded-xl shadow-sm border border-amber-200 hover:border-amber-400 transition-all flex items-center gap-3">
              <div className="w-8 h-8 bg-amber-50 text-amber-700 rounded-lg flex items-center justify-center shrink-0">
                <FileSearch size={16} />
              </div>
              <div>
                <h4 className="font-bold text-sm text-neutral-800">Phase 7I BOM Alias Correction</h4>
                <p className="text-xs text-neutral-500">Correct V2 BOM aliases</p>
              </div>
            </Link>

          </motion.div>
        )}
      </motion.div>
    </div>
  );
}
