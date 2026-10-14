import React, { useState, useEffect, useRef } from 'react';
import { Header, AppTab } from './components/Header.tsx';
import { CustomerPreOrder } from './components/CustomerPreOrder.tsx';
import { CashierPOS } from './components/CashierPOS.tsx';
import { KitchenKDS } from './components/KitchenKDS.tsx';
import { OwnerDashboard } from './components/OwnerDashboard.tsx';
import { AdminSettings } from './components/AdminSettings.tsx';
import { MvpEstimateModal } from './components/MvpEstimateModal.tsx';
import { RoleAccessModal } from './components/RoleAccessModal.tsx';
import { MenuItem, Order, Ingredient, FinancialReport, KitchenStatus, CafeSettings, StaffUser } from './types.ts';
import { INITIAL_MENU, INITIAL_INGREDIENTS, INITIAL_ORDERS, INITIAL_SETTINGS, INITIAL_STAFF } from './data/mockData.ts';
import { announceOrderToKitchen } from './utils/audio.ts';
import { 
  supabase, 
  mapMenuFromDb, 
  mapInventoryFromDb, 
  mapOrderFromDb, 
  mapOrderToDb, 
  mapSettingsFromDb, 
  mapStaffFromDb 
} from './utils/supabase.ts';

// Helper to parse role and standalone mode from pathname and search params
const getInitialRoleAndKiosk = (): { tab: AppTab; standalone: boolean } => {
  if (typeof window === 'undefined') return { tab: 'customer', standalone: false };
  const path = window.location.pathname.toLowerCase();
  const search = new URLSearchParams(window.location.search);
  const roleQuery = (search.get('role') || '').toLowerCase();
  const isKiosk = search.get('standalone') === 'true' || search.get('kios') === 'true';

  if (path.includes('/cashier') || path.includes('/kasir') || path.includes('/pos') || ['cashier', 'kasir', 'pos'].includes(roleQuery)) {
    return { tab: 'cashier', standalone: isKiosk };
  }
  if (path.includes('/kitchen') || path.includes('/dapur') || path.includes('/kds') || ['kitchen', 'dapur', 'kds'].includes(roleQuery)) {
    return { tab: 'kitchen', standalone: isKiosk };
  }
  if (path.includes('/owner') || path.includes('/laporan') || ['owner', 'laporan'].includes(roleQuery)) {
    return { tab: 'owner', standalone: isKiosk };
  }
  if (path.includes('/admin') || roleQuery === 'admin') {
    return { tab: 'admin', standalone: isKiosk };
  }
  if (path.includes('/customer') || path.includes('/pelanggan') || ['customer', 'pelanggan'].includes(roleQuery)) {
    return { tab: 'customer', standalone: isKiosk };
  }
  return { tab: 'customer', standalone: isKiosk };
};

export default function App() {
  const initialConfig = getInitialRoleAndKiosk();
  const [activeTab, setActiveTabState] = useState<AppTab>(initialConfig.tab);
  const [isStandalone, setIsStandalone] = useState<boolean>(initialConfig.standalone);
  const [showRoleAccessModal, setShowRoleAccessModal] = useState<boolean>(false);

  const [menuList, setMenuList] = useState<MenuItem[]>(INITIAL_MENU);
  const [ingredients, setIngredients] = useState<Ingredient[]>(INITIAL_INGREDIENTS);
  const [orders, setOrders] = useState<Order[]>(INITIAL_ORDERS);
  const [settings, setSettings] = useState<CafeSettings>(INITIAL_SETTINGS);
  const [staffList, setStaffList] = useState<StaffUser[]>(INITIAL_STAFF);
  const [currentStaffUser, setCurrentStaffUser] = useState<StaffUser | null>(null);
  const [report, setReport] = useState<FinancialReport>({
    totalRevenue: 0,
    totalOrders: 0,
    preOrderRevenue: 0,
    cashierRevenue: 0,
    qrisRevenue: 0,
    cashRevenue: 0,
    noShowCount: 0,
    noShowProtectedRevenue: 0,
    inventoryValue: 0,
  });

  const [isOfflineMode, setIsOfflineMode] = useState<boolean>(false);
  const [audioAlertsEnabled, setAudioAlertsEnabled] = useState<boolean>(true);
  const [showEstimateModal, setShowEstimateModal] = useState<boolean>(false);

  // Tab switcher with URL history sync
  const handleTabChange = (newTab: AppTab, updateUrl = true) => {
    setActiveTabState(newTab);
    if (updateUrl && typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('role', newTab);
      if (isStandalone) {
        url.searchParams.set('standalone', 'true');
      } else {
        url.searchParams.delete('standalone');
      }
      window.history.pushState({ tab: newTab, standalone: isStandalone }, '', url.toString());
    }
  };

  // Exit standalone kiosk mode
  const handleExitStandalone = () => {
    setIsStandalone(false);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('standalone');
      url.searchParams.delete('kios');
      window.history.replaceState({ tab: activeTab, standalone: false }, '', url.toString());
    }
  };

  // Handle browser back / forward navigation
  useEffect(() => {
    const handlePopState = () => {
      const cfg = getInitialRoleAndKiosk();
      setActiveTabState(cfg.tab);
      setIsStandalone(cfg.standalone);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Keep track of previous orders count to trigger audio TTS on newly created orders
  const prevOrderCountRef = useRef<number>(orders.length);

  // Load data from backend API with automatic Supabase direct fallback
  const fetchAllData = async () => {
    try {
      // 1. Fetch menu
      let menuLoaded = false;
      try {
        const menuRes = await fetch('/api/menu');
        const cType = menuRes.headers.get('content-type') || '';
        if (menuRes.ok && cType.includes('application/json')) {
          const menuJson = await menuRes.json();
          if (menuJson.success && menuJson.data) {
            setMenuList(menuJson.data);
            menuLoaded = true;
          }
        }
      } catch {}

      if (!menuLoaded) {
        try {
          const { data } = await supabase.from('menu').select('*');
          if (data && data.length > 0) setMenuList(data.map(mapMenuFromDb));
        } catch {}
      }

      // 2. Fetch inventory
      let invLoaded = false;
      try {
        const invRes = await fetch('/api/inventory');
        const cType = invRes.headers.get('content-type') || '';
        if (invRes.ok && cType.includes('application/json')) {
          const invJson = await invRes.json();
          if (invJson.success && invJson.data) {
            setIngredients(invJson.data);
            invLoaded = true;
          }
        }
      } catch {}

      if (!invLoaded) {
        try {
          const { data } = await supabase.from('inventory').select('*');
          if (data && data.length > 0) setIngredients(data.map(mapInventoryFromDb));
        } catch {}
      }

      // 3. Fetch orders
      let ordersLoaded = false;
      try {
        const ordersRes = await fetch('/api/orders');
        const cType = ordersRes.headers.get('content-type') || '';
        if (ordersRes.ok && cType.includes('application/json')) {
          const ordersJson = await ordersRes.json();
          if (ordersJson.success && ordersJson.data) {
            const newOrders: Order[] = ordersJson.data;

            if (newOrders.length > prevOrderCountRef.current && audioAlertsEnabled) {
              const newest = newOrders[0];
              const itemsStr = newest.items.map(i => `${i.name} ${i.quantity}`).join(', ');
              announceOrderToKitchen(
                newest.source === 'preorder' ? `Pre-Order ${newest.customerName}` : 'Kasir',
                itemsStr
              );
            }
            prevOrderCountRef.current = newOrders.length;
            setOrders(newOrders);
            ordersLoaded = true;
          }
        }
      } catch {}

      if (!ordersLoaded) {
        try {
          const { data } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
          if (data && data.length > 0) {
            const newOrders = data.map(mapOrderFromDb);
            prevOrderCountRef.current = newOrders.length;
            setOrders(newOrders);
          }
        } catch {}
      }

      // 4. Fetch reports
      try {
        const reportsRes = await fetch('/api/reports');
        const cType = reportsRes.headers.get('content-type') || '';
        if (reportsRes.ok && cType.includes('application/json')) {
          const reportsJson = await reportsRes.json();
          if (reportsJson.success && reportsJson.data) setReport(reportsJson.data);
        }
      } catch {}

      // 5. Fetch cafe operational settings
      let settingsLoaded = false;
      try {
        const settingsRes = await fetch('/api/settings');
        const cType = settingsRes.headers.get('content-type') || '';
        if (settingsRes.ok && cType.includes('application/json')) {
          const settingsJson = await settingsRes.json();
          if (settingsJson.success && settingsJson.data) {
            setSettings(settingsJson.data);
            settingsLoaded = true;
          }
        }
      } catch {}

      if (!settingsLoaded) {
        try {
          const { data } = await supabase.from('cafe_settings').select('*').limit(1).maybeSingle();
          if (data) setSettings(mapSettingsFromDb(data));
        } catch {}
      }

      // 6. Fetch staff roster
      let staffLoaded = false;
      try {
        const staffRes = await fetch('/api/staff');
        const cType = staffRes.headers.get('content-type') || '';
        if (staffRes.ok && cType.includes('application/json')) {
          const staffJson = await staffRes.json();
          if (staffJson.success && staffJson.data) {
            setStaffList(staffJson.data);
            staffLoaded = true;
          }
        }
      } catch {}

      if (!staffLoaded) {
        try {
          const { data } = await supabase.from('staff').select('*');
          if (data && data.length > 0) setStaffList(data.map(mapStaffFromDb));
        } catch {}
      }
    } catch {
      // Server might be booting or offline
    }
  };

  useEffect(() => {
    fetchAllData();

    // Poll every 5 seconds for real-time updates across screens
    const interval = setInterval(() => {
      if (!isOfflineMode) {
        fetchAllData();
      }
    }, 4500);

    return () => clearInterval(interval);
  }, [isOfflineMode, audioAlertsEnabled]);

  // Create new order handler (Dual-engine: Edge/Express API + Direct Supabase fallback)
  const handleCreateOrder = async (orderPayload: Partial<Order>): Promise<Order | null> => {
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderPayload),
      });
      const cType = res.headers.get('content-type') || '';
      if (res.ok && cType.includes('application/json')) {
        const json = await res.json();
        if (json.success && json.data) {
          const createdOrder: Order = json.data;
          setOrders(prev => [createdOrder, ...prev]);
          prevOrderCountRef.current += 1;

          if (audioAlertsEnabled) {
            const itemsStr = createdOrder.items.map(i => `${i.name} ${i.quantity}`).join(', ');
            announceOrderToKitchen(
              createdOrder.source === 'preorder' ? `Pre-Order ${createdOrder.customerName}` : 'Kasir',
              itemsStr
            );
          }

          fetchAllData();
          return createdOrder;
        }
      }
    } catch (e) {
      console.warn('API /api/orders unavailable, fallback to local and Supabase direct', e);
    }

    // Direct Supabase / local fallback
    const fallbackId = `ORD-${Date.now().toString().slice(-4)}`;
    const fallbackOrder: Order = {
      id: fallbackId,
      source: orderPayload.source || 'preorder',
      customerName: orderPayload.customerName || (orderPayload.source === 'preorder' ? 'Pelanggan Pre-Order' : 'Pelanggan Meja'),
      customerPhone: orderPayload.customerPhone || '',
      estimatedArrival: orderPayload.estimatedArrival || '15 menit lagi',
      hasArrived: orderPayload.source === 'cashier',
      items: orderPayload.items || [],
      totalAmount: orderPayload.totalAmount || 0,
      paymentMethod: orderPayload.paymentMethod || 'qris',
      paymentStatus: 'paid',
      isNonRefundable: orderPayload.source === 'preorder',
      cashReceived: orderPayload.cashReceived,
      cashChange: orderPayload.cashChange,
      kitchenStatus: (orderPayload.source === 'preorder' && orderPayload.items?.some(i => i.isSensitive)) ? 'menunggu_kedatangan' : 'antrean_dapur',
      createdAt: new Date().toISOString(),
      isTakeaway: Boolean(orderPayload.isTakeaway),
      tableNumber: orderPayload.tableNumber || '',
    };

    setOrders(prev => [fallbackOrder, ...prev]);
    prevOrderCountRef.current += 1;

    if (audioAlertsEnabled) {
      const itemsStr = fallbackOrder.items.map(i => `${i.name} ${i.quantity}`).join(', ');
      announceOrderToKitchen(
        fallbackOrder.source === 'preorder' ? `Pre-Order ${fallbackOrder.customerName}` : 'Kasir',
        itemsStr
      );
    }

    try {
      await supabase.from('orders').insert(mapOrderToDb(fallbackOrder));
    } catch {}

    return fallbackOrder;
  };

  // Customer triggers "Saya Sudah Sampai" or Staff triggers "Konfirmasi Pelanggan Hadir (Manual)"
  const handleMarkArrived = async (orderId: string) => {
    try {
      const res = await fetch(`/api/orders/${orderId}/arrived`, {
        method: 'PATCH',
      });
      const cType = res.headers.get('content-type') || '';
      if (res.ok && cType.includes('application/json')) {
        const json = await res.json();
        if (json.success && json.data) {
          setOrders(prev => prev.map(o => o.id === orderId ? json.data : o));

          if (audioAlertsEnabled) {
            announceOrderToKitchen(
              json.data.customerName,
              'Pelanggan telah sampai di kafe! Segera racik menu pesanan sekarang.'
            );
          }
          return;
        }
      }
    } catch (e) {
      console.warn('API /api/orders/:id/arrived failed, fallback to local state & Supabase', e);
    }

    // Local & Supabase fallback
    const arrivedAt = new Date().toISOString();
    setOrders(prev => prev.map(o => {
      if (o.id === orderId) {
        return {
          ...o,
          hasArrived: true,
          arrivedAt,
          kitchenStatus: o.kitchenStatus === 'menunggu_kedatangan' ? 'antrean_dapur' : o.kitchenStatus,
        };
      }
      return o;
    }));

    try {
      await supabase.from('orders').update({
        has_arrived: true,
        arrived_at: arrivedAt,
        kitchen_status: 'antrean_dapur'
      }).eq('id', orderId);
    } catch {}

    if (audioAlertsEnabled) {
      const targetOrder = orders.find(o => o.id === orderId);
      announceOrderToKitchen(
        targetOrder ? targetOrder.customerName : 'Pelanggan',
        'Pelanggan telah sampai di kafe! Segera racik menu pesanan sekarang.'
      );
    }
  };

  // Kitchen updates ticket status
  const handleUpdateStatus = async (orderId: string, status: KitchenStatus) => {
    try {
      const res = await fetch(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const cType = res.headers.get('content-type') || '';
      if (res.ok && cType.includes('application/json')) {
        const json = await res.json();
        if (json.success && json.data) {
          setOrders(prev => prev.map(o => o.id === orderId ? json.data : o));
          return;
        }
      }
    } catch (e) {
      console.warn('Failed to update status on server, fallback to local & Supabase', e);
    }

    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, kitchenStatus: status } : o));
    try {
      await supabase.from('orders').update({ kitchen_status: status }).eq('id', orderId);
    } catch {}
  };

  // Mark customer as No-Show (Protected non-refundable revenue retained)
  const handleMarkNoShow = async (orderId: string) => {
    try {
      const res = await fetch(`/api/orders/${orderId}/noshow`, {
        method: 'POST',
      });
      const json = await res.json();
      if (json.success && json.data) {
        setOrders(prev => prev.map(o => o.id === orderId ? json.data : o));
        fetchAllData();
      }
    } catch (e) {
      console.error('Failed to mark no-show', e);
    }
  };

  // Cashier POS orders offline sync
  const handleSyncOfflineQueue = async (offlineOrders: Order[]): Promise<number> => {
    try {
      const res = await fetch('/api/orders/sync-offline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders: offlineOrders }),
      });
      const json = await res.json();
      if (json.success) {
        fetchAllData();
        return json.syncedCount || offlineOrders.length;
      }
    } catch (e) {
      console.error('Failed to sync offline orders', e);
    }
    return 0;
  };

  // Restock inventory ingredient
  const handleRestock = async (ingredientId: string, amount: number) => {
    try {
      const res = await fetch('/api/inventory/restock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ingredientId, amount }),
      });
      const json = await res.json();
      if (json.success) {
        fetchAllData();
      }
    } catch (e) {
      console.error('Failed to restock', e);
    }
  };

  // Active counts for header badges
  const activeOrderCount = orders.filter(o => o.source === 'preorder' && o.kitchenStatus !== 'selesai').length;
  const kitchenWaitingCount = orders.filter(o => o.kitchenStatus === 'menunggu_kedatangan' || o.kitchenStatus === 'antrean_dapur').length;

  return (
    <div className="min-h-screen bg-stone-100 flex flex-col font-sans selection:bg-amber-200">
      {/* Global Navigation Header with Role Access & Standalone Kiosk Support */}
      <Header
        cafeName={settings.cafeName}
        activeTab={activeTab}
        setActiveTab={handleTabChange}
        activeOrderCount={activeOrderCount}
        kitchenWaitingCount={kitchenWaitingCount}
        isOfflineMode={isOfflineMode}
        setIsOfflineMode={setIsOfflineMode}
        audioAlertsEnabled={audioAlertsEnabled}
        setAudioAlertsEnabled={setAudioAlertsEnabled}
        onOpenEstimate={() => setShowEstimateModal(true)}
        onOpenRoleAccess={() => setShowRoleAccessModal(true)}
        isStandalone={isStandalone}
        onExitStandalone={handleExitStandalone}
      />

      {/* Main Content Area */}
      <main className="flex-1 pb-16">
        {/* Active Staff Persona Notification Bar */}
        {currentStaffUser && (
          <div className="bg-amber-900 text-amber-100 px-4 py-2 text-xs flex items-center justify-between shadow-xs">
            <div className="flex items-center space-x-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              <span>
                Mode Simulasi Karyawan Aktif: <strong>{currentStaffUser.name}</strong> ({currentStaffUser.role.toUpperCase()}) - KafeKu Senopati
              </span>
            </div>
            <button
              onClick={() => {
                setCurrentStaffUser(null);
                handleTabChange('admin');
              }}
              className="text-amber-200 hover:text-white font-bold underline cursor-pointer text-[11px]"
            >
              Keluar ke Mode Admin
            </button>
          </div>
        )}

        {/* Access Control Interceptor */}
        {currentStaffUser && currentStaffUser.role === 'kasir' && activeTab !== 'cashier' ? (
          <div className="max-w-xl mx-auto my-12 p-8 bg-white rounded-3xl border border-stone-200 text-center space-y-4 shadow-sm">
            <div className="w-12 h-12 rounded-2xl bg-amber-100 text-amber-800 flex items-center justify-center mx-auto font-bold text-xl">
              🔒
            </div>
            <h3 className="font-extrabold text-stone-900 text-lg">Akses Dibatasi (Role: Kasir)</h3>
            <p className="text-stone-500 text-xs leading-relaxed">
              Akun <strong>{currentStaffUser.name}</strong> hanya memiliki izin untuk mengoperasikan layar Kasir POS.
            </p>
            <div className="flex justify-center space-x-3 pt-2">
              <button
                onClick={() => handleTabChange('cashier')}
                className="bg-amber-800 text-white text-xs font-bold px-4 py-2.5 rounded-xl hover:bg-amber-900 shadow-xs cursor-pointer"
              >
                Buka Kasir POS
              </button>
              <button
                onClick={() => {
                  setCurrentStaffUser(null);
                  handleTabChange('admin');
                }}
                className="bg-stone-100 text-stone-700 text-xs font-bold px-4 py-2.5 rounded-xl hover:bg-stone-200 cursor-pointer"
              >
                Kembali ke Admin
              </button>
            </div>
          </div>
        ) : currentStaffUser && currentStaffUser.role === 'koki' && activeTab !== 'kitchen' ? (
          <div className="max-w-xl mx-auto my-12 p-8 bg-white rounded-3xl border border-stone-200 text-center space-y-4 shadow-sm">
            <div className="w-12 h-12 rounded-2xl bg-orange-100 text-orange-800 flex items-center justify-center mx-auto font-bold text-xl">
              🍳
            </div>
            <h3 className="font-extrabold text-stone-900 text-lg">Akses Dibatasi (Role: Koki)</h3>
            <p className="text-stone-500 text-xs leading-relaxed">
              Akun <strong>{currentStaffUser.name}</strong> hanya memiliki izin untuk mengoperasikan layar Dapur (KDS).
            </p>
            <div className="flex justify-center space-x-3 pt-2">
              <button
                onClick={() => handleTabChange('kitchen')}
                className="bg-orange-600 text-white text-xs font-bold px-4 py-2.5 rounded-xl hover:bg-orange-700 shadow-xs cursor-pointer"
              >
                Buka Dapur KDS
              </button>
              <button
                onClick={() => {
                  setCurrentStaffUser(null);
                  handleTabChange('admin');
                }}
                className="bg-stone-100 text-stone-700 text-xs font-bold px-4 py-2.5 rounded-xl hover:bg-stone-200 cursor-pointer"
              >
                Kembali ke Admin
              </button>
            </div>
          </div>
        ) : (
          <>
            {activeTab === 'customer' && (
              <CustomerPreOrder
                menuList={menuList}
                orders={orders}
                onCreateOrder={handleCreateOrder}
                onMarkArrived={handleMarkArrived}
                isOfflineMode={isOfflineMode}
                settings={settings}
              />
            )}

            {activeTab === 'cashier' && (
              <CashierPOS
                menuList={menuList}
                onOrderCreated={(newOrder) => {
                  setOrders(prev => [newOrder, ...prev]);
                  prevOrderCountRef.current += 1;
                  fetchAllData();
                }}
                isOfflineMode={isOfflineMode}
                setIsOfflineMode={setIsOfflineMode}
                onSyncOfflineQueue={handleSyncOfflineQueue}
                tables={settings.tables}
                orders={orders}
                onMarkArrived={handleMarkArrived}
              />
            )}

            {activeTab === 'kitchen' && (
              <KitchenKDS
                orders={orders}
                onUpdateStatus={handleUpdateStatus}
                onMarkArrived={handleMarkArrived}
                onMarkNoShow={handleMarkNoShow}
                audioAlertsEnabled={audioAlertsEnabled}
                setAudioAlertsEnabled={setAudioAlertsEnabled}
              />
            )}

            {activeTab === 'owner' && (
              <OwnerDashboard
                report={report}
                ingredients={ingredients}
                orders={orders}
                onRestock={handleRestock}
                onRefreshData={fetchAllData}
              />
            )}

            {activeTab === 'admin' && (
              <AdminSettings
                menuList={menuList}
                settings={settings}
                staffList={staffList}
                currentStaffUser={currentStaffUser}
                report={report}
                onUpdateMenu={setMenuList}
                onUpdateSettings={setSettings}
                onUpdateStaff={setStaffList}
                onSwitchStaffUser={setCurrentStaffUser}
                onRefreshAll={fetchAllData}
                onOpenRoleAccess={() => setShowRoleAccessModal(true)}
              />
            )}
          </>
        )}
      </main>

      {/* Role Access & Deployment Center Modal */}
      <RoleAccessModal
        isOpen={showRoleAccessModal}
        onClose={() => setShowRoleAccessModal(false)}
        onSwitchTab={(tab) => handleTabChange(tab)}
        cafeName={settings.cafeName}
      />

      {/* MVP Estimation & Timeline Modal */}
      <MvpEstimateModal
        isOpen={showEstimateModal}
        onClose={() => setShowEstimateModal(false)}
      />
    </div>
  );
}
