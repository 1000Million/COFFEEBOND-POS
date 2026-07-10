import React, { useState } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Coffee, LogOut, LayoutDashboard, Calculator, FileText, ChefHat, Menu, X, ShoppingBag, ListChecks, Wrench, PackagePlus } from 'lucide-react';

export default function Layout() {
  const { staffProfile, logout } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const location = useLocation();
  const isPos = location.pathname === '/pos';

  if (!staffProfile) return null;

  const role = staffProfile.role;

  // Determine navigation links based on role
  const navLinks = [];

  if (role === 'ADMIN' || role === 'STORE_MANAGER' || role === 'CASHIER') {
    navLinks.push({ to: '/pos', label: 'POS', title: 'POS', icon: Calculator });
    navLinks.push({ to: '/pos/running-orders', label: 'Running', title: 'Running Orders', icon: ListChecks });
    navLinks.push({ to: '/pos/incoming-orders', label: 'Online', title: 'Online Orders', icon: ShoppingBag });
    navLinks.push({ to: '/reports', label: 'Reports', title: 'Reports', icon: FileText });
  }

  if (role === 'ADMIN' || role === 'STORE_MANAGER') {
    navLinks.push({ to: '/inventory/control', label: 'Inventory', title: 'Inventory Control', icon: LayoutDashboard });
    navLinks.push({ to: '/inventory/stock-correction', label: 'Stock', title: 'Stock Correction', icon: Wrench });
    navLinks.push({ to: '/inventory/purchase-entry', label: 'Purchases', title: 'Purchase Entry', icon: PackagePlus });
  }
  
  if (role === 'ADMIN' || role === 'STORE_MANAGER' || role === 'BARISTA') {
    navLinks.push({ to: '/kot/barista', label: 'Barista', title: 'Barista KOT', icon: Coffee });
  }
  
  if (role === 'ADMIN' || role === 'STORE_MANAGER' || role === 'KITCHEN') {
    navLinks.push({ to: '/kot/kitchen', label: 'Kitchen', title: 'Kitchen KOT', icon: ChefHat });
  }
  
  if (role === 'ADMIN' || role === 'STORE_MANAGER' || role === 'CASHIER') {
    navLinks.push({ to: '/kot/ready', label: 'Ready', title: 'Ready to Serve', icon: Coffee });
  }

  const showAdmin = role === 'ADMIN';

  return (
    <div className="min-h-[100dvh] min-w-0 overflow-x-hidden bg-[#f9f5f0] flex flex-col font-sans text-neutral-800">
      <header className={`bg-white border-b border-neutral-200 px-4 md:px-6 py-3 flex items-center justify-between gap-3 sticky top-0 z-50 min-w-0 ${isPos ? 'hidden lg:flex' : ''}`}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="md:hidden">
             <button 
               onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
               className="p-1.5 text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100 rounded-lg transition-colors"
             >
               {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
             </button>
          </div>
          <div className="w-9 h-9 bg-[#5c4033] rounded-lg flex items-center justify-center text-[#f9f5f0]">
            <Coffee size={18} />
          </div>
          <div className="hidden sm:block">
            <h1 className="text-lg font-black tracking-tight text-[#3e2723] leading-none">Coffee Bond</h1>
            <span className="text-[9px] font-bold text-neutral-500 uppercase tracking-widest">Point of Sale</span>
          </div>
        </div>

        {/* Center Nav - Desktop */}
        <nav className="hidden md:flex min-w-0 max-w-full items-center gap-1 overflow-x-auto bg-neutral-50 p-1 rounded-full border border-neutral-200 mx-4 custom-scrollbar">
          {navLinks.map((link) => (
            <NavLink 
              key={link.to} 
              to={link.to}
              title={link.title}
              className={({ isActive }) => 
                `px-4 py-1.5 rounded-full text-sm font-semibold transition-all flex items-center gap-1.5 ${
                  isActive ? 'bg-white text-[#5c4033] shadow-sm ring-1 ring-neutral-200/50' : 'text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100'
                }`
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        {/* Right Section */}
        <div className="flex min-w-0 shrink-0 items-center gap-3 md:gap-4">
          {showAdmin && (
            <NavLink 
              to="/admin"
              className={({ isActive }) => 
                `hidden md:flex px-4 py-1.5 rounded-full text-sm font-bold transition-all items-center gap-1.5 border ${
                  isActive ? 'bg-[#5c4033] text-white border-[#5c4033] shadow-sm' : 'bg-white text-[#5c4033] border-[#5c4033]/30 hover:bg-[#5c4033]/5'
                }`
              }
            >
              <LayoutDashboard size={16} />
              Admin
            </NavLink>
          )}

          <div className="flex min-w-0 flex-col items-end">
            <span className="max-w-[120px] truncate text-[13px] font-bold text-neutral-800 leading-tight sm:max-w-[180px]">{staffProfile.name}</span>
            <span className="text-[9px] font-bold text-amber-700 bg-amber-50 px-1.5 py-[1px] rounded uppercase tracking-wider">
              {staffProfile.role.replace('_', ' ')}
            </span>
          </div>
          
          <button 
            onClick={logout}
            className="p-1.5 text-neutral-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
            title="Sign Out"
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>

      {/* Mobile Nav Menu */}
      {mobileMenuOpen && (
        <nav className="md:hidden flex flex-col bg-white border-b border-neutral-200 px-4 py-2 absolute top-[61px] left-0 right-0 z-40 max-h-[calc(100dvh-61px)] overflow-y-auto shadow-lg">
          {navLinks.map((link) => (
            <NavLink 
              key={link.to} 
              to={link.to}
              onClick={() => setMobileMenuOpen(false)}
              className={({ isActive }) => 
                `px-4 py-3 rounded-xl text-sm font-bold transition-colors flex items-center gap-2 my-1 ${
                  isActive ? 'bg-[#5c4033]/5 text-[#5c4033]' : 'text-neutral-600 hover:bg-neutral-50'
                }`
              }
            >
              <link.icon size={16} />
              {link.label}
            </NavLink>
          ))}
          
          {showAdmin && (
            <div className="mt-2 pt-2 border-t border-neutral-100">
               <NavLink 
                to="/admin"
                onClick={() => setMobileMenuOpen(false)}
                className={({ isActive }) => 
                  `px-4 py-3 rounded-xl text-sm font-bold transition-colors flex items-center gap-2 ${
                    isActive ? 'bg-[#5c4033] text-white' : 'text-[#5c4033] bg-[#5c4033]/5 hover:bg-[#5c4033]/10'
                  }`
                }
              >
                <LayoutDashboard size={16} />
                Admin Dashboard
              </NavLink>
            </div>
          )}
        </nav>
      )}

      <main className={`flex-1 flex flex-col w-full min-w-0 h-full max-w-[1600px] mx-auto overflow-x-hidden ${isPos ? 'p-0 lg:p-4 lg:md:p-6' : 'p-4 md:p-6'}`}>
        <Outlet />
      </main>
      
      {!isPos && (
        <footer className="bg-[#f9f5f0] text-center pb-2 relative z-10 opacity-60 hover:opacity-100 transition-opacity">
           <p className="text-[10px] font-mono text-neutral-400 font-medium tracking-wider">COFFEE BOND INC.</p>
        </footer>
      )}
    </div>
  );
}
