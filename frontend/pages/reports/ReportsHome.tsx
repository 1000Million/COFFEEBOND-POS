import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db } from '../../lib/firebase';
import { collection, query, where, getDocs, Timestamp, orderBy } from 'firebase/firestore';
import { Order, OrderItem, KotItem, Store } from '../../types';
import { Calendar, Download, Store as StoreIcon, Loader2, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function ReportsHome() {
  const { staffProfile } = useAuth();
  
  // Date State
  const [dateStr, setDateStr] = useState<string>(new Date().toISOString().split('T')[0]);
  
  // Filters State
  const [selectedStoreId, setSelectedStoreId] = useState<string>('ALL');
  const [selectedOrderType, setSelectedOrderType] = useState<string>('ALL');
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<string>('ALL');

  // Active Stores
  const [stores, setStores] = useState<Store[]>([]);
  
  // Data State
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [orderItems, setOrderItems] = useState<(OrderItem & { orderId: string })[]>([]);
  const [kotItems, setKotItems] = useState<KotItem[]>([]);
  const [newCustomersToday, setNewCustomersToday] = useState<number>(0);
  
  // Data Fetching
  useEffect(() => {
    let active = true;
    const fetchStores = async () => {
      try {
        const snap = await getDocs(query(collection(db, 'stores'), where('isActive', '==', true)));
        const loadedStores = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Store));
        if (active) {
          setStores(loadedStores);
        }
      } catch (err) {
        console.error('Failed to fetch stores', err);
      }
    };
    fetchStores();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!staffProfile) return;
    
    // Manage default store properly based on role
    if (staffProfile.role === 'ADMIN') {
      // Keep selectedStoreId
    } else {
      if (selectedStoreId === 'ALL' && staffProfile.storeIds.length === 1) {
        setSelectedStoreId(staffProfile.storeIds[0]);
      } else if (selectedStoreId === 'ALL' && staffProfile.storeIds.length === 0) {
        // Leave as is, won't load anything
      } else if (selectedStoreId !== 'ALL' && !staffProfile.storeIds.includes(selectedStoreId)) {
        setSelectedStoreId(staffProfile.storeIds[0] || 'ALL');
      }
    }
  }, [staffProfile, selectedStoreId]);

  useEffect(() => {
    let active = true;
    const loadReportData = async () => {
      if (!staffProfile) return;
      setLoading(true);
      setErrorMsg(null);

      const [year, month, day] = dateStr.split('-').map(Number);
      const startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0);
      const endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);
      
      const startTs = Timestamp.fromDate(startOfDay);
      const endTs = Timestamp.fromDate(endOfDay);

      try {
        let loadedOrders: Order[] = [];

        if (staffProfile.role === 'ADMIN' && selectedStoreId === 'ALL') {
          const qOrders = query(
            collection(db, 'orders'),
            where('createdAt', '>=', startTs),
            where('createdAt', '<=', endTs)
          );
          const ordersSnap = await getDocs(qOrders);
          loadedOrders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() } as Order));
        } else {
          const storesToFetch = selectedStoreId === 'ALL' ? staffProfile.storeIds : [selectedStoreId];
          if (storesToFetch.length > 0) {
            const orderSnaps = await Promise.all(storesToFetch.map(storeId => getDocs(query(
              collection(db, 'orders'),
              where('storeId', '==', storeId),
              where('createdAt', '>=', startTs),
              where('createdAt', '<=', endTs)
            ))));
            loadedOrders = orderSnaps.flatMap(snap => snap.docs.map(d => ({ id: d.id, ...d.data() } as Order)));
          }
        }

        // Fetch sub-items in parallel for these orders
        // 100 orders -> 100 getDocs is surprisingly fast on Firestore, but chunking is safer if scale grows.
        let allItems: (OrderItem & { orderId: string })[] = [];
        const itemPromises = loadedOrders.map(async (o) => {
          if (!o.id) return;
          const iSnap = await getDocs(collection(db, 'orders', o.id, 'items'));
          const items = iSnap.docs.map(d => ({ id: d.id, orderId: o.id, ...d.data() } as OrderItem & { orderId: string }));
          allItems.push(...items);
        });
        await Promise.all(itemPromises);

        // Fetch KOTs (Only if Admin or Manager)
        let loadedKots: KotItem[] = [];
        let newCustCount = 0;
        if (staffProfile.role === 'ADMIN' || staffProfile.role === 'STORE_MANAGER') {
          if (staffProfile.role === 'ADMIN' && selectedStoreId === 'ALL') {
            const qKot = query(
              collection(db, 'kotItems'),
              where('createdAt', '>=', startTs),
              where('createdAt', '<=', endTs)
            );
            const kotSnap = await getDocs(qKot);
            loadedKots = kotSnap.docs.map(d => ({ id: d.id, ...d.data() } as KotItem));
          } else {
            const storesToFetch = selectedStoreId === 'ALL' ? staffProfile.storeIds : [selectedStoreId];
            if (storesToFetch.length > 0) {
              const kotSnaps = await Promise.all(storesToFetch.map(storeId => getDocs(query(
                collection(db, 'kotItems'),
                where('storeId', '==', storeId),
                where('createdAt', '>=', startTs),
                where('createdAt', '<=', endTs)
              ))));
              loadedKots = kotSnaps.flatMap(snap => snap.docs.map(d => ({ id: d.id, ...d.data() } as KotItem)));
            }
          }

          // Customer documents are not store-scoped yet, so only Admin sees the global new-customer count.
          if (staffProfile.role === 'ADMIN') {
          const qCust = query(
            collection(db, 'customers'),
            where('createdAt', '>=', startTs),
            where('createdAt', '<=', endTs)
          );
          const custSnap = await getDocs(qCust);
          newCustCount = custSnap.docs.length;
          }
        }

        if (active) {
          setOrders(loadedOrders);
          setOrderItems(allItems);
          setKotItems(loadedKots);
          setNewCustomersToday(newCustCount);
          setLoading(false);
        }

      } catch (err: any) {
        console.error('Failed to load report data', err);
        if (active) {
           setLoading(false);
           if (err.message && (err.message.includes('requires an index') || err.message.includes('failed-precondition'))) {
             setErrorMsg("Firestore index required. Open the Firebase Console link from the browser console and create the index.");
           } else {
             setErrorMsg("Failed to load report data: " + err.message);
           }
        }
      }
    };
    
    loadReportData();
    return () => { active = false; };
  }, [dateStr, staffProfile, selectedStoreId]);

  // Derived filtered orders
  const filteredOrders = useMemo(() => {
    const fOrders = orders.filter(o => {
      if (selectedOrderType !== 'ALL' && o.orderType !== selectedOrderType) return false;
      if (selectedPaymentMethod !== 'ALL' && o.paymentMethod !== selectedPaymentMethod) return false;
      return true;
    });

    if (import.meta.env.DEV) {
      const selectedStoreName = stores.find(s => s.id === selectedStoreId)?.name || 'ALL';
      const uniqueStoreIds = Array.from(new Set(fOrders.map(o => o.storeId)));
      console.log("[REPORTS] selectedStoreId:", selectedStoreId);
      console.log("[REPORTS] selectedStoreName:", selectedStoreName);
      console.log("[REPORTS] orders before store filter:", orders.length);
      console.log("[REPORTS] orders after store filter:", fOrders.length);
      console.log("[REPORTS] storeIds in filtered orders:", uniqueStoreIds);
    }
    return fOrders;
  }, [orders, selectedOrderType, selectedPaymentMethod, selectedStoreId, stores]);
  
  const filteredOrderIds = useMemo(() => new Set(filteredOrders.map(o => o.id)), [filteredOrders]);
  
  const filteredItems = useMemo(() => {
    return orderItems.filter(i => filteredOrderIds.has(i.orderId as string));
  }, [orderItems, filteredOrderIds]);

  // Metrics
  const totalSales = filteredOrders.reduce((sum, o) => sum + (o.grandTotal || 0), 0);
  const totalBills = filteredOrders.length;
  const avgOrderValue = totalBills > 0 ? (totalSales / totalBills) : 0;
  const totalTax = filteredOrders.reduce((sum, o) => sum + (o.taxTotal || 0), 0);
  const totalDiscount = filteredOrders.reduce((sum, o) => sum + (o.discountTotal || 0), 0);
  
  const paidSales = filteredOrders.filter(o => o.paymentStatus === 'PAID').reduce((sum, o) => sum + (o.grandTotal || 0), 0);
  const unpaidSales = filteredOrders.filter(o => o.paymentMethod === 'CREDIT' || o.paymentStatus !== 'PAID').reduce((sum, o) => sum + (o.grandTotal || 0), 0);
  const compSales = filteredOrders.filter(o => o.paymentMethod === 'COMPLIMENTARY').reduce((sum, o) => sum + (o.grandTotal || 0), 0);

  const dineInCount = filteredOrders.filter(o => o.orderType === 'DINE_IN').length;
  const takeawayCount = filteredOrders.filter(o => o.orderType === 'TAKEAWAY').length;
  const deliveryCount = filteredOrders.filter(o => o.orderType === 'DELIVERY').length;

  const paymentSummary = useMemo(() => {
    const summary: Record<string, { count: number, total: number }> = {};
    filteredOrders.forEach(o => {
      const pm = o.paymentMethod || 'UNKNOWN';
      if (!summary[pm]) summary[pm] = { count: 0, total: 0 };
      summary[pm].count += 1;
      summary[pm].total += o.grandTotal || 0;
    });
    return summary;
  }, [filteredOrders]);

  const categorySummary = useMemo(() => {
    const summary: Record<string, { count: number, total: number, tax: number }> = {};
    filteredItems.forEach(item => {
      const cat = item.categoryName || 'Unknown Category';
      if (!summary[cat]) summary[cat] = { count: 0, total: 0, tax: 0 };
      summary[cat].count += item.quantity;
      summary[cat].total += item.lineTotal || 0;
      summary[cat].tax += item.lineTax || 0;
    });
    return Object.entries(summary).sort((a,b) => b[1].total - a[1].total);
  }, [filteredItems]);

  const topItems = useMemo(() => {
     const summary: Record<string, { count: number, total: number, orders: Set<string> }> = {};
     filteredItems.forEach(item => {
       const nm = item.itemName || 'Unknown Item';
       if (!summary[nm]) summary[nm] = { count: 0, total: 0, orders: new Set() };
       summary[nm].count += item.quantity;
       summary[nm].total += item.lineTotal || 0;
       summary[nm].orders.add(item.orderId as string);
     });
     return Object.entries(summary).sort((a,b) => b[1].count - a[1].count).slice(0, 5);
  }, [filteredItems]);
  
  const hourlySales = useMemo(() => {
    const hours = Array.from({length: 24}, (_, i) => ({ hour: i, count: 0, total: 0 }));
    filteredOrders.forEach(o => {
       if (o.createdAt) {
         const date = o.createdAt.toDate();
         const h = date.getHours();
         hours[h].count += 1;
         hours[h].total += o.grandTotal || 0;
       }
    });
    return hours.filter(h => h.count > 0);
  }, [filteredOrders]);

  // Additional Reports for Admin/Manager
  const { walkInOrders, customerOrders, topCustomers } = useMemo(() => {
    let walkIn = 0;
    let custOrds = 0;
    const custSpend: Record<string, { name: string, total: number }> = {};
    
    filteredOrders.forEach(o => {
      if (!o.customerId) {
        walkIn++;
      } else {
        custOrds++;
        if (!custSpend[o.customerId]) {
          custSpend[o.customerId] = { name: o.customerName || 'Unknown', total: 0 };
        }
        custSpend[o.customerId].total += (o.grandTotal || 0);
      }
    });
    
    const top = Object.entries(custSpend)
      .sort((a,b) => b[1].total - a[1].total)
      .slice(0, 5)
      .map(([id, data]) => ({ id, ...data }));
      
    return { walkInOrders: walkIn, customerOrders: custOrds, topCustomers: top };
  }, [filteredOrders]);

  const storeComparison = useMemo(() => {
    if (staffProfile.role !== 'ADMIN') return [];
    
    const storeStats: Record<string, { storeName: string; totalSales: number; billCount: number; discount: number; topItemCounter: Record<string, number> }> = {};
    
    filteredOrders.forEach(o => {
      const s = o.storeId;
      if (!storeStats[s]) storeStats[s] = { storeName: o.storeName, totalSales: 0, billCount: 0, discount: 0, topItemCounter: {} };
      storeStats[s].totalSales += o.grandTotal || 0;
      storeStats[s].billCount += 1;
      storeStats[s].discount += o.discountTotal || 0;
    });
    
    filteredItems.forEach(i => {
       const o = filteredOrders.find(ord => ord.id === i.orderId);
       if (o && storeStats[o.storeId]) {
         const nm = i.itemName || 'Unknown Item';
         if (!storeStats[o.storeId].topItemCounter[nm]) storeStats[o.storeId].topItemCounter[nm] = 0;
         storeStats[o.storeId].topItemCounter[nm] += i.quantity;
       }
    });

    return Object.entries(storeStats).map(([id, st]) => {
      const best = Object.entries(st.topItemCounter).sort((a,b) => b[1] - a[1])[0];
      return { 
        id, 
        storeName: st.storeName, 
        totalSales: st.totalSales, 
        billCount: st.billCount, 
        avgOrderValue: st.billCount > 0 ? st.totalSales / st.billCount : 0,
        discount: st.discount,
        topItem: best ? best[0] : 'None'
      };
    }).sort((a,b) => b.totalSales - a.totalSales);
  }, [filteredOrders, filteredItems, staffProfile.role]);

  const handleExportCSV = (type: 'orders' | 'payments' | 'categories' | 'items') => {
    let rows: string[] = [];
    if (type === 'orders') {
      rows.push(['Date', 'Time', 'Order #', 'Store', 'Type', 'Customer', 'Subtotal', 'Tax', 'Discount', 'Total', 'Payment', 'Status'].join(','));
      filteredOrders.forEach(o => {
        const d = o.createdAt?.toDate();
        rows.push([
          d?.toLocaleDateString() || '',
          d?.toLocaleTimeString() || '',
          o.orderNumber,
          o.storeName,
          o.orderType,
          o.customerName || 'Walk-in',
          o.subtotal,
          o.taxTotal,
          o.discountTotal,
          o.grandTotal,
          o.paymentMethod,
          o.paymentStatus
        ].map(col => `"${col}"`).join(','));
      });
    } else if (type === 'payments') {
      rows.push(['Payment Method', 'Orders Count', 'Total Amount'].join(','));
      Object.entries(paymentSummary).forEach(([pm, stats]) => {
        rows.push(`"${pm}",${stats.count},${stats.total.toFixed(2)}`);
      });
    } else if (type === 'categories') {
      rows.push(['Category', 'Items Sold', 'Net Total', 'Tax Total'].join(','));
      categorySummary.forEach(([cat, stats]) => {
        rows.push(`"${cat}",${stats.count},${stats.total.toFixed(2)},${stats.tax.toFixed(2)}`);
      });
    } else if (type === 'items') {
      rows.push(['Item', 'Quantity Sold', 'Orders Appeared In', 'Total Amount'].join(','));
      topItems.forEach(([nm, stats]) => {
        rows.push(`"${nm}",${stats.count},${stats.orders.size},${stats.total.toFixed(2)}`);
      });
    }

    const csvContent = "data:text/csv;charset=utf-8," + rows.join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `${type}_report_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (!staffProfile) return null;

  return (
    <div className="min-h-screen bg-[#fcf9f5] pb-24 font-sans text-neutral-800">
      
      <div className="bg-white border-b border-neutral-200 sticky top-0 z-30 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link to="/pos" className="w-10 h-10 bg-neutral-100 hover:bg-neutral-200 text-neutral-600 rounded-full flex items-center justify-center transition-colors">
              <ArrowLeft size={20} />
            </Link>
            <div>
              <h1 className="text-2xl font-black tracking-tight text-neutral-900">Dashboard & Reports</h1>
              <p className="text-sm font-medium text-neutral-500">Live POS performance and metrics</p>
            </div>
          </div>
          
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} />
              <input 
                type="date"
                value={dateStr}
                onChange={e => setDateStr(e.target.value)}
                disabled={staffProfile.role === 'CASHIER'}
                className="pl-9 pr-4 py-2 bg-neutral-50 border border-neutral-200 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] disabled:opacity-70 disabled:cursor-not-allowed"
              />
            </div>
            
            {staffProfile.role !== 'CASHIER' && (
              <div className="relative">
                <StoreIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} />
                <select
                  value={selectedStoreId}
                  onChange={e => setSelectedStoreId(e.target.value)}
                  className="appearance-none pl-9 pr-8 py-2 bg-neutral-50 border border-neutral-200 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]"
                >
                  {(staffProfile.role === 'ADMIN' || staffProfile.storeIds.length > 1) && (
                     <option value="ALL">All Authorized Stores</option>
                  )}
                  {stores.filter(s => staffProfile.role === 'ADMIN' || staffProfile.storeIds.includes(s.id)).map(s => (
                     <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}
            
          </div>
        </div>
        
        {/* Secondary filters */}
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-3 border-t border-neutral-100 flex flex-wrap gap-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-bold text-neutral-500 uppercase tracking-widest text-[10px]">Type</span>
            <select value={selectedOrderType} onChange={e => setSelectedOrderType(e.target.value)} className="bg-transparent font-medium border-b border-neutral-200 focus:border-[#5c4033] outline-none px-1 py-0.5">
              <option value="ALL">All Types</option>
              <option value="DINE_IN">Dine-in</option>
              <option value="TAKEAWAY">Takeaway</option>
              <option value="DELIVERY">Delivery</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-neutral-500 uppercase tracking-widest text-[10px]">Payment</span>
            <select value={selectedPaymentMethod} onChange={e => setSelectedPaymentMethod(e.target.value)} className="bg-transparent font-medium border-b border-neutral-200 focus:border-[#5c4033] outline-none px-1 py-0.5">
              <option value="ALL">All Methods</option>
              <option value="CASH">Cash</option>
              <option value="UPI">UPI</option>
              <option value="CARD">Card</option>
              <option value="SWIGGY">Swiggy</option>
              <option value="ZOMATO">Zomato</option>
              <option value="CREDIT">Credit</option>
              <option value="COMPLIMENTARY">Complimentary</option>
            </select>
          </div>
        </div>
      </div>
      
      <div className="max-w-7xl mx-auto px-4 md:px-8 mt-8">
        {errorMsg && (
          <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl mb-6 font-bold flex gap-3 text-sm">
            <p>{errorMsg}</p>
          </div>
        )}
        
        {loading ? (
           <div className="h-64 flex items-center justify-center flex-col gap-4 text-neutral-400">
             <Loader2 size={32} className="animate-spin text-[#5c4033]" />
             <p className="font-medium animate-pulse">Running calculations...</p>
           </div>
        ) : filteredOrders.length === 0 ? (
          <div className="bg-white rounded-2xl p-12 shadow-sm border border-neutral-200 text-center">
            <h2 className="text-xl font-bold text-neutral-800 mb-2">No sales found</h2>
            <p className="text-neutral-500">There are no orders matching your filters for this date.</p>
          </div>
        ) : (
          <div className="space-y-6">
            
            {/* KPI Row 1 */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
               <div className="col-span-2 bg-white rounded-2xl p-6 shadow-sm border border-neutral-200 relative overflow-hidden group">
                 <div className="absolute inset-0 bg-gradient-to-r from-[#5c4033]/5 to-transparent pointer-events-none" />
                 <p className="text-xs font-bold text-[#5c4033] uppercase tracking-widest mb-1 opacity-80">Total Gross Sales</p>
                 <h2 className="text-4xl font-mono font-black text-neutral-900 tracking-tight">₹{totalSales.toFixed(2)}</h2>
               </div>
               
               <div className="bg-white rounded-2xl p-6 shadow-sm border border-neutral-200">
                 <p className="text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Total Bills</p>
                 <h2 className="text-3xl font-mono font-bold text-neutral-800">{totalBills}</h2>
               </div>
               
               <div className="bg-white rounded-2xl p-6 shadow-sm border border-neutral-200">
                 <p className="text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Avg Order Val</p>
                 <h2 className="text-3xl font-mono font-bold text-neutral-800">₹{Math.round(avgOrderValue)}</h2>
               </div>

               <div className="bg-white rounded-2xl p-6 shadow-sm border border-neutral-200">
                 <p className="text-xs font-bold text-neutral-500 uppercase tracking-widest mb-1">Total Tax</p>
                 <h2 className="text-3xl font-mono font-bold text-neutral-800">₹{Math.round(totalTax)}</h2>
               </div>
            </div>

            {/* Sub-KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
              <div className="bg-white/50 border border-neutral-200 rounded-xl p-4">
                 <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest mb-1">Dine-in</div>
                 <div className="text-xl font-bold font-mono">{dineInCount}</div>
              </div>
              <div className="bg-white/50 border border-neutral-200 rounded-xl p-4">
                 <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest mb-1">Takeaway</div>
                 <div className="text-xl font-bold font-mono">{takeawayCount}</div>
              </div>
              <div className="bg-white/50 border border-neutral-200 rounded-xl p-4">
                 <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest mb-1">Delivery</div>
                 <div className="text-xl font-bold font-mono">{deliveryCount}</div>
              </div>
              <div className="bg-white/50 border border-green-200/50 rounded-xl p-4">
                 <div className="text-[10px] font-bold text-green-700 uppercase tracking-widest mb-1">Paid</div>
                 <div className="text-xl font-bold font-mono text-green-800">₹{Math.round(paidSales)}</div>
              </div>
              <div className="bg-white/50 border border-red-200/50 rounded-xl p-4">
                 <div className="text-[10px] font-bold text-red-700 uppercase tracking-widest mb-1">Credit / Unpaid</div>
                 <div className="text-xl font-bold font-mono text-red-800">₹{Math.round(unpaidSales)}</div>
              </div>
              <div className="bg-white/50 border border-purple-200/50 rounded-xl p-4">
                 <div className="text-[10px] font-bold text-purple-700 uppercase tracking-widest mb-1">Complimentary</div>
                 <div className="text-xl font-bold font-mono text-purple-800">₹{Math.round(compSales)}</div>
              </div>
            </div>
            
            {/* Main reporting grids */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
               
               {/* Left Column: Categories and Payments */}
               <div className="lg:col-span-2 space-y-6">
                  
                  {/* Categories */}
                  <div className="bg-white border border-neutral-200 rounded-2xl shadow-sm overflow-hidden flex flex-col">
                    <div className="p-4 border-b border-neutral-100 flex items-center justify-between">
                       <h3 className="font-bold text-neutral-800">Category Sales</h3>
                       <button onClick={() => handleExportCSV('categories')} className="flex items-center gap-1.5 text-xs font-semibold text-[#5c4033] hover:bg-[#5c4033]/5 px-2 py-1 rounded transition-colors">
                         <Download size={14} /> Export
                       </button>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm whitespace-nowrap">
                        <thead className="bg-neutral-50 text-neutral-500 font-bold text-xs uppercase tracking-wider">
                          <tr>
                            <th className="px-4 py-3">Category</th>
                            <th className="px-4 py-3 text-right">Qty</th>
                            <th className="px-4 py-3 text-right">Sales</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-100 font-medium">
                          {categorySummary.map(([cat, stats]) => (
                            <tr key={cat} className="hover:bg-neutral-50 transition-colors">
                              <td className="px-4 py-3 text-neutral-900">{cat}</td>
                              <td className="px-4 py-3 text-right text-neutral-600">{stats.count}</td>
                              <td className="px-4 py-3 text-right font-mono text-[#5c4033]">₹{stats.total.toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Hourly */}
                  <div className="bg-white border border-neutral-200 rounded-2xl shadow-sm overflow-hidden flex flex-col">
                    <div className="p-4 border-b border-neutral-100">
                       <h3 className="font-bold text-neutral-800">Hourly Sales</h3>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm whitespace-nowrap">
                        <thead className="bg-neutral-50 text-neutral-500 font-bold text-xs uppercase tracking-wider">
                          <tr>
                            <th className="px-4 py-3">Hour</th>
                            <th className="px-4 py-3 text-right">Bills</th>
                            <th className="px-4 py-3 text-right">Avg Val</th>
                            <th className="px-4 py-3 text-right">Total</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-100 font-medium">
                          {hourlySales.map((h) => (
                            <tr key={h.hour} className="hover:bg-neutral-50 transition-colors">
                              <td className="px-4 py-3 text-neutral-900">{h.hour.toString().padStart(2,'0')}:00 - {h.hour.toString().padStart(2,'0')}:59</td>
                              <td className="px-4 py-3 text-right text-neutral-600">{h.count}</td>
                              <td className="px-4 py-3 text-right text-neutral-600 font-mono text-xs">₹{Math.round(h.total / h.count)}</td>
                              <td className="px-4 py-3 text-right font-mono text-[#5c4033]">₹{h.total.toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

               </div>
               
               {/* Right Column: Payments and Top Items */}
               <div className="space-y-6">
                  
                  {/* Payments */}
                  <div className="bg-white border border-neutral-200 rounded-2xl shadow-sm overflow-hidden flex flex-col">
                    <div className="p-4 border-b border-neutral-100 flex items-center justify-between">
                       <h3 className="font-bold text-neutral-800">Payments</h3>
                       <button onClick={() => handleExportCSV('payments')} className="flex items-center gap-1.5 text-xs font-semibold text-[#5c4033] hover:bg-[#5c4033]/5 px-2 py-1 rounded transition-colors">
                         <Download size={14} />
                       </button>
                    </div>
                    <div className="p-4 space-y-4">
                      {Object.entries(paymentSummary).sort((a,b) => b[1].total - a[1].total).map(([pm, stats]) => (
                        <div key={pm} className="flex justify-between items-center text-sm font-medium">
                          <span className="text-neutral-600 flex items-center gap-2">
                             <span className="w-1.5 h-1.5 rounded-full bg-neutral-300 inline-block"></span>
                             {pm} <span className="text-xs text-neutral-400">({stats.count})</span>
                          </span>
                          <span className="font-mono text-neutral-900">₹{stats.total.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Top Items */}
                  <div className="bg-white border border-neutral-200 rounded-2xl shadow-sm overflow-hidden flex flex-col">
                    <div className="p-4 border-b border-neutral-100 flex items-center justify-between">
                       <h3 className="font-bold text-neutral-800">Top Sellers</h3>
                       <button onClick={() => handleExportCSV('items')} className="flex items-center gap-1.5 text-xs font-semibold text-[#5c4033] hover:bg-[#5c4033]/5 px-2 py-1 rounded transition-colors">
                         <Download size={14} />
                       </button>
                    </div>
                    <div className="p-4 space-y-4">
                       {topItems.map(([nm, stats], idx) => (
                         <div key={nm} className="flex justify-between items-start text-sm">
                           <div className="flex gap-2">
                             <span className="text-neutral-400 font-mono text-xs mt-0.5">{idx+1}.</span>
                             <div>
                               <p className="font-bold text-neutral-800">{nm}</p>
                               <p className="text-xs text-neutral-500">{stats.count} sold</p>
                             </div>
                           </div>
                           <span className="font-mono text-[#5c4033] font-medium">₹{Math.round(stats.total)}</span>
                         </div>
                       ))}
                    </div>
                  </div>
                  
                  {/* Quick Export Orders */}
                  <button onClick={() => handleExportCSV('orders')} className="w-full flex items-center justify-center gap-2 py-3 bg-[#5c4033] hover:bg-[#4a332a] text-white rounded-xl font-bold transition-all shadow-sm hover:shadow object-cover outline-none focus:ring-2 focus:ring-[#5c4033]/20 focus:ring-offset-2">
                     <Download size={18} />
                     Export Detailed Orders CSV
                  </button>
               </div>
               
            </div>
            
            {/* KOT Performance & Store Comparison for Admin / Manager */}
            {(staffProfile.role === 'ADMIN' || staffProfile.role === 'STORE_MANAGER') && (
               <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-neutral-200">
                  <div className="bg-white border border-neutral-200 rounded-2xl shadow-sm p-6 space-y-4">
                     <h3 className="font-bold text-neutral-800 border-b border-neutral-100 pb-2">KOT Activity</h3>
                     <div className="flex flex-wrap gap-6 mt-4">
                        <div className="flex-1 min-w-[100px]">
                          <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest mb-1">Total Tickets</p>
                          <p className="text-3xl font-black font-mono text-neutral-900">{kotItems.length}</p>
                        </div>
                        <div className="flex-1 min-w-[100px]">
                          <p className="text-[10px] font-bold text-orange-400 uppercase tracking-widest mb-1">Barista</p>
                          <p className="text-3xl font-black font-mono text-orange-900">{kotItems.filter(k => k.station === 'BARISTA').length}</p>
                        </div>
                        <div className="flex-1 min-w-[100px]">
                          <p className="text-[10px] font-bold text-blue-400 uppercase tracking-widest mb-1">Kitchen</p>
                          <p className="text-3xl font-black font-mono text-blue-900">{kotItems.filter(k => k.station === 'KITCHEN').length}</p>
                        </div>
                     </div>
                     <div className="grid grid-cols-4 gap-2 pt-4">
                       <div className="bg-neutral-50 rounded-lg p-2 text-center border border-neutral-100">
                          <div className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest mb-1">Pending</div>
                          <div className="font-mono font-bold">{kotItems.filter(k => k.status === 'PENDING').length}</div>
                       </div>
                       <div className="bg-amber-50 rounded-lg p-2 text-center border border-amber-100 mt-0">
                          <div className="text-[10px] font-bold text-amber-500 uppercase tracking-widest mb-1">Prep</div>
                          <div className="font-mono font-bold text-amber-700">{kotItems.filter(k => k.status === 'PREPARING').length}</div>
                       </div>
                       <div className="bg-emerald-50 rounded-lg p-2 text-center border border-emerald-100">
                          <div className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mb-1">Ready</div>
                          <div className="font-mono font-bold text-emerald-700">{kotItems.filter(k => k.status === 'READY').length}</div>
                       </div>
                       <div className="bg-neutral-100 rounded-lg p-2 text-center border border-neutral-200">
                          <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest mb-1">Served</div>
                          <div className="font-mono font-bold text-neutral-700">{kotItems.filter(k => k.status === 'SERVED').length}</div>
                       </div>
                     </div>
                  </div>
                  
                  <div className="bg-white border border-neutral-200 rounded-2xl shadow-sm p-6 space-y-4">
                     <h3 className="font-bold text-neutral-800 border-b border-neutral-100 pb-2">Customer Insights</h3>
                     <div className="grid grid-cols-2 gap-4 pt-2">
                        <div>
                           <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest mb-1">New Signups</p>
                           <p className="text-2xl font-black font-mono text-neutral-900">{newCustomersToday}</p>
                        </div>
                        <div>
                           <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest mb-1">Customer Orders</p>
                           <p className="text-2xl font-black font-mono text-neutral-900">{customerOrders}</p>
                        </div>
                        <div>
                           <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest mb-1">Walk-in Orders</p>
                           <p className="text-2xl font-black font-mono text-neutral-900">{walkInOrders}</p>
                        </div>
                        <div>
                           <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest mb-1">% Linked</p>
                           <p className="text-2xl font-black font-mono text-neutral-900">{totalBills ? Math.round((customerOrders/totalBills)*100) : 0}%</p>
                        </div>
                     </div>
                     {topCustomers.length > 0 && (
                       <div className="mt-4 pt-4 border-t border-neutral-100">
                          <p className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest mb-2">Top Spenders</p>
                          <div className="space-y-1.5">
                             {topCustomers.map(c => (
                               <div key={c.id} className="flex justify-between text-xs font-medium">
                                 <span>{c.name}</span>
                                 <span className="font-mono text-[#5c4033]">₹{Math.round(c.total)}</span>
                               </div>
                             ))}
                          </div>
                       </div>
                     )}
                  </div>
               </div>
            )}
            
            {staffProfile.role === 'ADMIN' && storeComparison.length > 0 && (
               <div className="bg-white border border-neutral-200 rounded-2xl shadow-sm overflow-hidden flex flex-col mt-6">
                 <div className="p-4 border-b border-neutral-100">
                    <h3 className="font-bold text-neutral-800">Store Performance Comparison</h3>
                 </div>
                 <div className="overflow-x-auto">
                   <table className="w-full text-left text-sm whitespace-nowrap">
                     <thead className="bg-[#fcf9f5] text-[#5c4033] font-bold text-[10px] uppercase tracking-wider">
                       <tr>
                         <th className="px-4 py-3">Store Name</th>
                         <th className="px-4 py-3 text-right">Bills</th>
                         <th className="px-4 py-3 text-right">Avg Val</th>
                         <th className="px-4 py-3 text-right">Discount</th>
                         <th className="px-4 py-3">Top Item</th>
                         <th className="px-4 py-3 text-right">Total Net</th>
                       </tr>
                     </thead>
                     <tbody className="divide-y divide-neutral-100 font-medium text-xs">
                       {storeComparison.map(st => (
                         <tr key={st.id} className="hover:bg-neutral-50 transition-colors">
                           <td className="px-4 py-3 text-neutral-900 font-bold">{st.storeName}</td>
                           <td className="px-4 py-3 text-right text-neutral-600">{st.billCount}</td>
                           <td className="px-4 py-3 text-right text-neutral-600 font-mono">₹{Math.round(st.avgOrderValue)}</td>
                           <td className="px-4 py-3 text-right text-red-600 font-mono opacity-80">₹{Math.round(st.discount)}</td>
                           <td className="px-4 py-3 text-neutral-500 max-w-[120px] truncate">{st.topItem}</td>
                           <td className="px-4 py-3 text-right font-mono font-bold text-neutral-900 text-sm">₹{Math.round(st.totalSales)}</td>
                         </tr>
                       ))}
                     </tbody>
                   </table>
                 </div>
               </div>
            )}
            
            
          </div>
        )}
        
        {import.meta.env.DEV && (
          <div className="max-w-7xl mx-auto px-4 md:px-8 mt-4 text-center text-xs font-mono text-neutral-400">
             Debug: showing {filteredOrders.length} orders for selected store {selectedStoreId}
          </div>
        )}
      </div>
    </div>
  );
}
