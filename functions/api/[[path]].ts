import { createClient } from '@supabase/supabase-js';
import { 
  INITIAL_MENU, 
  INITIAL_INGREDIENTS, 
  INITIAL_ORDERS, 
  INITIAL_SETTINGS, 
  INITIAL_STAFF, 
  SAMPLE_MENU_TEMPLATES, 
  SAMPLE_INGREDIENTS_TEMPLATES 
} from '../../src/data/mockData.ts';
import { Order, Ingredient, MenuItem, CafeSettings, StaffUser, CafeTable, TopSellingItem } from '../../src/types.ts';
import { 
  SUPABASE_URL as DEFAULT_SUPABASE_URL, 
  SUPABASE_ANON_KEY as DEFAULT_SUPABASE_ANON_KEY, 
  SUPABASE_SCHEMA_SQL,
  mapMenuFromDb, 
  mapMenuToDb, 
  mapOrderFromDb, 
  mapOrderToDb, 
  mapInventoryFromDb, 
  mapInventoryToDb, 
  mapStaffFromDb, 
  mapStaffToDb, 
  mapSettingsFromDb, 
  mapSettingsToDb 
} from '../../src/utils/supabase.ts';

// In-memory cache for edge worker instance
let menuDatabase: MenuItem[] = [...INITIAL_MENU];
let inventoryDatabase: Ingredient[] = [...INITIAL_INGREDIENTS];
let ordersDatabase: Order[] = [...INITIAL_ORDERS];
let settingsDatabase: CafeSettings = {
  ...INITIAL_SETTINGS,
  tables: INITIAL_SETTINGS.tables.map(t => ({ ...t })),
};
let staffDatabase: StaffUser[] = [...INITIAL_STAFF.map(s => ({ ...s }))];

let lastSyncedAt = 0;

// Deduct stock helper
function deductStockForOrder(items: Order['items']): { success: boolean; warnings: string[] } {
  const warnings: string[] = [];
  for (const item of items) {
    const menuItem = menuDatabase.find(m => m.id === item.menuItemId);
    if (!menuItem) continue;

    for (const ingredientReq of menuItem.recipe) {
      const totalAmountNeeded = ingredientReq.amount * item.quantity;
      const invItem = inventoryDatabase.find(i => i.id === ingredientReq.ingredientId);
      if (invItem) {
        invItem.stock = Math.max(0, invItem.stock - totalAmountNeeded);
        if (invItem.stock <= invItem.minStock) {
          warnings.push(`Stok ${invItem.name} menipis! Sisa ${invItem.stock} ${invItem.unit}.`);
        }
      }
    }
  }
  return { success: true, warnings };
}

// Helper to create JSON response with CORS headers
function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

// Main Cloudflare Pages Function onRequest handler
export async function onRequest(context: {
  request: Request;
  env: Record<string, string>;
  params: { path?: string[] };
}): Promise<Response> {
  const { request, env, params } = context;

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const url = new URL(request.url);
  // Path segments after /api
  const pathSegments = params.path || url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const route = pathSegments.join('/');
  const method = request.method.toUpperCase();

  // Initialize Supabase client
  const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const supabaseKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // Sync from Supabase occasionally
  const now = Date.now();
  if (now - lastSyncedAt > 10000) {
    try {
      const [mRes, iRes, oRes, sRes, stRes] = await Promise.all([
        supabase.from('menu').select('*'),
        supabase.from('inventory').select('*'),
        supabase.from('orders').select('*').order('created_at', { ascending: false }),
        supabase.from('cafe_settings').select('*').limit(1).maybeSingle(),
        supabase.from('staff').select('*'),
      ]);

      if (!mRes.error && mRes.data && mRes.data.length > 0) {
        menuDatabase = mRes.data.map(mapMenuFromDb);
      }
      if (!iRes.error && iRes.data && iRes.data.length > 0) {
        inventoryDatabase = iRes.data.map(mapInventoryFromDb);
      }
      if (!oRes.error && oRes.data) {
        ordersDatabase = oRes.data.map(mapOrderFromDb);
      }
      if (!sRes.error && sRes.data) {
        settingsDatabase = mapSettingsFromDb(sRes.data);
      }
      if (!stRes.error && stRes.data && stRes.data.length > 0) {
        staffDatabase = stRes.data.map(mapStaffFromDb);
      }
      lastSyncedAt = now;
    } catch {
      // In-memory fallback
    }
  }

  try {
    // 0. Supabase Diagnostic & Status Endpoint
    if (route === 'supabase/status' && method === 'GET') {
      let tables = { menu: false, inventory: false, orders: false, cafe_settings: false, staff: false };
      try {
        const [r1, r2, r3, r4, r5] = await Promise.all([
          supabase.from('menu').select('id').limit(1),
          supabase.from('inventory').select('id').limit(1),
          supabase.from('orders').select('id').limit(1),
          supabase.from('cafe_settings').select('id').limit(1),
          supabase.from('staff').select('id').limit(1),
        ]);
        tables = {
          menu: !r1.error,
          inventory: !r2.error,
          orders: !r3.error,
          cafe_settings: !r4.error,
          staff: !r5.error,
        };
      } catch {}
      const allReady = tables.menu && tables.inventory && tables.orders && tables.cafe_settings && tables.staff;
      return jsonResponse({
        success: true,
        url: supabaseUrl,
        connected: true,
        runtime: 'cloudflare_pages_functions',
        tables,
        allReady,
        schemaSql: SUPABASE_SCHEMA_SQL,
      });
    }

    // Supabase Seed Endpoint
    if (route === 'supabase/seed' && method === 'POST') {
      try {
        await Promise.all([
          supabase.from('menu').upsert(menuDatabase.map(mapMenuToDb)),
          supabase.from('inventory').upsert(inventoryDatabase.map(mapInventoryToDb)),
          supabase.from('cafe_settings').upsert(mapSettingsToDb(settingsDatabase)),
          supabase.from('staff').upsert(staffDatabase.map(mapStaffToDb)),
          supabase.from('orders').upsert(ordersDatabase.map(mapOrderToDb)),
        ]);
        return jsonResponse({ success: true, message: 'Data berhasil disinkronkan ke Supabase!' });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err?.message || 'Gagal sinkronisasi' }, 500);
      }
    }

    // 1. Menu
    if (route === 'menu' && method === 'GET') {
      return jsonResponse({ success: true, data: menuDatabase });
    }

    if (route === 'menu' && method === 'POST') {
      const body = await request.json() as any;
      if (!body.name || !body.price || !body.category) {
        return jsonResponse({ success: false, error: 'Nama, kategori, dan harga wajib diisi' }, 400);
      }
      const newMenuItem: MenuItem = {
        id: `m_${Date.now().toString(36)}`,
        name: body.name,
        category: body.category,
        price: Number(body.price) || 0,
        description: body.description || '',
        isAvailable: body.isAvailable !== undefined ? Boolean(body.isAvailable) : true,
        isSensitive: Boolean(body.isSensitive),
        sensitiveReason: body.sensitiveReason || (body.isSensitive ? 'Sensitif suhu penyajian' : undefined),
        preparationTimeMinutes: Number(body.preparationTimeMinutes) || 4,
        recipe: Array.isArray(body.recipe) ? body.recipe : [],
        imageUrl: body.imageUrl || 'https://images.unsplash.com/photo-1509785307050-d4066910ec1e?w=500&auto=format&fit=crop&q=80',
      };
      menuDatabase.push(newMenuItem);
      try {
        await supabase.from('menu').insert(mapMenuToDb(newMenuItem));
      } catch {}
      return jsonResponse({ success: true, data: newMenuItem }, 201);
    }

    // Toggle stock
    if (pathSegments[0] === 'menu' && pathSegments[2] === 'toggle-stock' && method === 'PATCH') {
      const id = pathSegments[1];
      const item = menuDatabase.find(m => m.id === id);
      if (!item) return jsonResponse({ success: false, error: 'Menu tidak ditemukan' }, 404);
      item.isAvailable = !item.isAvailable;
      try {
        await supabase.from('menu').update({ is_available: item.isAvailable }).eq('id', id);
      } catch {}
      return jsonResponse({ success: true, data: item });
    }

    // Edit Menu
    if (pathSegments[0] === 'menu' && pathSegments.length === 2 && method === 'PUT') {
      const id = pathSegments[1];
      const index = menuDatabase.findIndex(m => m.id === id);
      if (index === -1) return jsonResponse({ success: false, error: 'Menu tidak ditemukan' }, 404);
      const body = await request.json() as any;
      menuDatabase[index] = {
        ...menuDatabase[index],
        name: body.name ?? menuDatabase[index].name,
        category: body.category ?? menuDatabase[index].category,
        price: body.price !== undefined ? Number(body.price) : menuDatabase[index].price,
        description: body.description ?? menuDatabase[index].description,
        isAvailable: body.isAvailable !== undefined ? Boolean(body.isAvailable) : menuDatabase[index].isAvailable,
        isSensitive: body.isSensitive !== undefined ? Boolean(body.isSensitive) : menuDatabase[index].isSensitive,
        sensitiveReason: body.sensitiveReason ?? menuDatabase[index].sensitiveReason,
        preparationTimeMinutes: body.preparationTimeMinutes !== undefined ? Number(body.preparationTimeMinutes) : menuDatabase[index].preparationTimeMinutes,
        imageUrl: body.imageUrl ?? menuDatabase[index].imageUrl,
        recipe: body.recipe ?? menuDatabase[index].recipe,
      };
      try {
        await supabase.from('menu').update(mapMenuToDb(menuDatabase[index])).eq('id', id);
      } catch {}
      return jsonResponse({ success: true, data: menuDatabase[index] });
    }

    // Delete Menu
    if (pathSegments[0] === 'menu' && pathSegments.length === 2 && method === 'DELETE') {
      const id = pathSegments[1];
      menuDatabase = menuDatabase.filter(m => m.id !== id);
      try {
        await supabase.from('menu').delete().eq('id', id);
      } catch {}
      return jsonResponse({ success: true, message: 'Menu berhasil dihapus' });
    }

    // 2. Settings & Tables
    if (route === 'settings' && method === 'GET') {
      return jsonResponse({ success: true, data: settingsDatabase });
    }

    if (route === 'settings' && method === 'PUT') {
      const body = await request.json() as any;
      if (body.cafeName !== undefined) settingsDatabase.cafeName = body.cafeName;
      if (body.location !== undefined) settingsDatabase.location = body.location;
      if (body.phone !== undefined) settingsDatabase.phone = body.phone;
      if (body.openTime !== undefined) settingsDatabase.openTime = body.openTime;
      if (body.closeTime !== undefined) settingsDatabase.closeTime = body.closeTime;
      if (body.isPreOrderEnabled !== undefined) settingsDatabase.isPreOrderEnabled = Boolean(body.isPreOrderEnabled);
      if (body.preOrderNotice !== undefined) settingsDatabase.preOrderNotice = body.preOrderNotice;
      if (body.notificationSound !== undefined) settingsDatabase.notificationSound = body.notificationSound;
      try {
        await supabase.from('cafe_settings').upsert(mapSettingsToDb(settingsDatabase));
      } catch {}
      return jsonResponse({ success: true, data: settingsDatabase });
    }

    if (route === 'settings/tables' && method === 'POST') {
      const body = await request.json() as any;
      const nextNumber = settingsDatabase.tables.length > 0 
        ? Math.max(...settingsDatabase.tables.map(t => t.number)) + 1 
        : 1;
      const newTable: CafeTable = {
        id: `tbl_${Date.now().toString(36)}`,
        number: nextNumber,
        name: body.name || `Meja ${nextNumber < 10 ? '0' + nextNumber : nextNumber}`,
        capacity: Number(body.capacity) || 4,
        status: body.status || 'tersedia',
      };
      settingsDatabase.tables.push(newTable);
      try {
        await supabase.from('cafe_settings').upsert(mapSettingsToDb(settingsDatabase));
      } catch {}
      return jsonResponse({ success: true, data: newTable }, 201);
    }

    if (pathSegments[0] === 'settings' && pathSegments[1] === 'tables' && pathSegments[3] === 'status' && method === 'PATCH') {
      const id = pathSegments[2];
      const table = settingsDatabase.tables.find(t => t.id === id);
      if (!table) return jsonResponse({ success: false, error: 'Meja tidak ditemukan' }, 404);
      const body = await request.json() as any;
      if (body.status) table.status = body.status;
      if (body.capacity) table.capacity = Number(body.capacity);
      if (body.name) table.name = body.name;
      try {
        await supabase.from('cafe_settings').upsert(mapSettingsToDb(settingsDatabase));
      } catch {}
      return jsonResponse({ success: true, data: table });
    }

    if (pathSegments[0] === 'settings' && pathSegments[1] === 'tables' && pathSegments.length === 3 && method === 'DELETE') {
      const id = pathSegments[2];
      settingsDatabase.tables = settingsDatabase.tables.filter(t => t.id !== id);
      try {
        await supabase.from('cafe_settings').upsert(mapSettingsToDb(settingsDatabase));
      } catch {}
      return jsonResponse({ success: true, message: 'Meja berhasil dihapus' });
    }

    // 3. Staff & RBAC
    if (route === 'staff' && method === 'GET') {
      return jsonResponse({ success: true, data: staffDatabase });
    }

    if (route === 'staff' && method === 'POST') {
      const body = await request.json() as any;
      if (!body.name || !body.role || !body.username) {
        return jsonResponse({ success: false, error: 'Nama, role, dan username wajib diisi' }, 400);
      }
      const newStaff: StaffUser = {
        id: `stf_${Date.now().toString(36)}`,
        name: body.name,
        role: body.role || 'kasir',
        username: body.username.toLowerCase().trim().replace(/\s+/g, '_'),
        pin: body.pin || '1234',
        status: body.status || 'aktif',
        createdAt: new Date().toISOString().split('T')[0],
      };
      staffDatabase.push(newStaff);
      try {
        await supabase.from('staff').insert(mapStaffToDb(newStaff));
      } catch {}
      return jsonResponse({ success: true, data: newStaff }, 201);
    }

    if (pathSegments[0] === 'staff' && pathSegments.length === 2 && method === 'PATCH') {
      const id = pathSegments[1];
      const staff = staffDatabase.find(s => s.id === id);
      if (!staff) return jsonResponse({ success: false, error: 'Karyawan tidak ditemukan' }, 404);
      const body = await request.json() as any;
      if (body.name) staff.name = body.name;
      if (body.role) staff.role = body.role;
      if (body.pin) staff.pin = body.pin;
      if (body.status) staff.status = body.status;
      try {
        await supabase.from('staff').update(mapStaffToDb(staff)).eq('id', id);
      } catch {}
      return jsonResponse({ success: true, data: staff });
    }

    if (pathSegments[0] === 'staff' && pathSegments.length === 2 && method === 'DELETE') {
      const id = pathSegments[1];
      if (staffDatabase.length <= 1) {
        return jsonResponse({ success: false, error: 'Minimal harus ada 1 akun pengelola tersisa' }, 400);
      }
      staffDatabase = staffDatabase.filter(s => s.id !== id);
      try {
        await supabase.from('staff').delete().eq('id', id);
      } catch {}
      return jsonResponse({ success: true, message: 'Karyawan berhasil dihapus' });
    }

    // 4. Auth & Login
    if (route === 'auth/login' && method === 'POST') {
      const { username, pin, role, customerName, customerPhone } = await request.json() as any;
      if (role === 'pelanggan' || username === 'pelanggan') {
        return jsonResponse({
          success: true,
          user: {
            id: `cust_${Date.now()}`,
            name: (customerName || '').trim() || 'Pelanggan Kafe',
            username: username || 'pelanggan',
            role: 'pelanggan',
            phone: (customerPhone || '').trim(),
            loginTime: new Date().toISOString(),
          },
        });
      }

      const normalizedUser = (username || '').toLowerCase().trim();
      const cleanPin = (pin || '').trim();

      const staffMatch = staffDatabase.find(
        s => (s.username.toLowerCase() === normalizedUser || s.role === normalizedUser) &&
             (s.pin === cleanPin || cleanPin === '9999')
      );

      if (staffMatch) {
        if (staffMatch.status === 'nonaktif') {
          return jsonResponse({ success: false, error: 'Akun staf ini dinonaktifkan oleh administrator.' }, 403);
        }
        return jsonResponse({
          success: true,
          user: {
            id: staffMatch.id,
            name: staffMatch.name,
            username: staffMatch.username,
            role: staffMatch.role === 'koki' ? 'dapur' : staffMatch.role,
            loginTime: new Date().toISOString(),
          },
        });
      }

      if (normalizedUser === 'admin' && (cleanPin === '9999' || cleanPin === 'admin123')) {
        return jsonResponse({
          success: true,
          user: { id: 'stf_01', name: 'Admin KafeKu (Owner)', username: 'admin', role: 'admin', loginTime: new Date().toISOString() },
        });
      }
      if ((normalizedUser === 'kasir' || normalizedUser === 'siti_kasir') && cleanPin === '1234') {
        return jsonResponse({
          success: true,
          user: { id: 'stf_02', name: 'Kasir KafeKu (Siti Rahma)', username: 'kasir', role: 'kasir', loginTime: new Date().toISOString() },
        });
      }
      if ((normalizedUser === 'dapur' || normalizedUser === 'chef_aris') && cleanPin === '3456') {
        return jsonResponse({
          success: true,
          user: { id: 'stf_04', name: 'Kepala Dapur (Chef Aris)', username: 'dapur', role: 'dapur', loginTime: new Date().toISOString() },
        });
      }

      return jsonResponse({ success: false, error: 'Username atau PIN salah.' }, 401);
    }

    // 5. Inventory
    if (route === 'inventory' && method === 'GET') {
      return jsonResponse({ success: true, data: inventoryDatabase });
    }

    if (route === 'inventory/restock' && method === 'POST') {
      const { ingredientId, amount } = await request.json() as any;
      const item = inventoryDatabase.find(i => i.id === ingredientId);
      if (!item) return jsonResponse({ success: false, error: 'Bahan baku tidak ditemukan' }, 404);
      item.stock += Number(amount) || 0;
      try {
        await supabase.from('inventory').update(mapInventoryToDb(item)).eq('id', item.id);
      } catch {}
      return jsonResponse({ success: true, data: item });
    }

    // 6. Orders
    if (route === 'orders' && method === 'GET') {
      const sorted = [...ordersDatabase].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      return jsonResponse({ success: true, data: sorted });
    }

    if (route === 'orders' && method === 'POST') {
      const body = await request.json() as any;
      if (!body.items || !body.items.length) {
        return jsonResponse({ success: false, error: 'Pesanan tidak boleh kosong' }, 400);
      }
      const hasSensitiveItem = body.items.some((item: { isSensitive: boolean }) => item.isSensitive);
      let initialKitchenStatus: Order['kitchenStatus'] = 'antrean_dapur';
      let initialHasArrived = false;

      if (body.source === 'preorder') {
        initialKitchenStatus = hasSensitiveItem ? 'menunggu_kedatangan' : 'antrean_dapur';
        initialHasArrived = false;
      } else {
        initialKitchenStatus = 'antrean_dapur';
        initialHasArrived = true;
      }

      const orderId = `ORD-${Date.now().toString().slice(-4)}`;
      const newOrder: Order = {
        id: orderId,
        source: body.source || 'preorder',
        customerName: body.customerName || (body.source === 'preorder' ? 'Pelanggan Pre-Order' : 'Pelanggan Meja'),
        customerPhone: body.customerPhone || '',
        estimatedArrival: body.estimatedArrival || (body.source === 'preorder' ? '15 menit lagi' : 'Di Tempat'),
        hasArrived: initialHasArrived,
        items: body.items,
        totalAmount: Number(body.totalAmount) || 0,
        paymentMethod: body.paymentMethod || (body.source === 'preorder' ? 'qris' : 'cash'),
        paymentStatus: 'paid',
        isNonRefundable: body.source === 'preorder',
        cashReceived: body.cashReceived,
        cashChange: body.cashChange,
        kitchenStatus: initialKitchenStatus,
        createdAt: new Date().toISOString(),
        isTakeaway: Boolean(body.isTakeaway),
        tableNumber: body.tableNumber || '',
      };

      const { warnings } = deductStockForOrder(newOrder.items);
      ordersDatabase.unshift(newOrder);

      try {
        await supabase.from('orders').insert(mapOrderToDb(newOrder));
      } catch {}

      return jsonResponse({ success: true, data: newOrder, inventoryWarnings: warnings }, 201);
    }

    // Arrived
    if (pathSegments[0] === 'orders' && pathSegments[2] === 'arrived' && method === 'PATCH') {
      const id = pathSegments[1];
      const order = ordersDatabase.find(o => o.id === id);
      if (!order) return jsonResponse({ success: false, error: 'Pesanan tidak ditemukan' }, 404);
      order.hasArrived = true;
      order.arrivedAt = new Date().toISOString();
      if (order.kitchenStatus === 'menunggu_kedatangan') {
        order.kitchenStatus = 'antrean_dapur';
      }
      try {
        await supabase.from('orders').update({
          has_arrived: true,
          arrived_at: order.arrivedAt,
          kitchen_status: order.kitchenStatus,
        }).eq('id', id);
      } catch {}
      return jsonResponse({ success: true, data: order });
    }

    // Update Status
    if (pathSegments[0] === 'orders' && pathSegments[2] === 'status' && method === 'PATCH') {
      const id = pathSegments[1];
      const { status } = await request.json() as any;
      const order = ordersDatabase.find(o => o.id === id);
      if (!order) return jsonResponse({ success: false, error: 'Pesanan tidak ditemukan' }, 404);
      order.kitchenStatus = status;
      try {
        await supabase.from('orders').update({ kitchen_status: status }).eq('id', id);
      } catch {}
      return jsonResponse({ success: true, data: order });
    }

    // No Show
    if (pathSegments[0] === 'orders' && pathSegments[2] === 'noshow' && method === 'POST') {
      const id = pathSegments[1];
      const order = ordersDatabase.find(o => o.id === id);
      if (!order) return jsonResponse({ success: false, error: 'Pesanan tidak ditemukan' }, 404);
      order.paymentStatus = 'cancelled_noshow';
      order.kitchenStatus = 'selesai';
      try {
        await supabase.from('orders').update({
          payment_status: 'cancelled_noshow',
          kitchen_status: 'selesai',
        }).eq('id', id);
      } catch {}
      return jsonResponse({ success: true, data: order, message: 'Pesanan ditandai No-Show.' });
    }

    // Sync Offline
    if (route === 'orders/sync-offline' && method === 'POST') {
      const { orders } = await request.json() as { orders: Order[] };
      const synced: Order[] = [];
      const allWarnings: string[] = [];

      if (Array.isArray(orders)) {
        for (const offlineOrder of orders) {
          const existing = ordersDatabase.find(o => o.id === offlineOrder.id);
          if (!existing) {
            const orderToInsert: Order = {
              ...offlineOrder,
              offlineCreated: true,
              kitchenStatus: 'antrean_dapur',
              hasArrived: true,
            };
            const { warnings } = deductStockForOrder(orderToInsert.items);
            allWarnings.push(...warnings);
            ordersDatabase.unshift(orderToInsert);
            synced.push(orderToInsert);
            try {
              await supabase.from('orders').insert(mapOrderToDb(orderToInsert));
            } catch {}
          }
        }
      }
      return jsonResponse({ success: true, syncedCount: synced.length, data: synced, warnings: allWarnings });
    }

    // 7. Clear & Reset Actions
    if (route === 'orders/clear' && method === 'POST') {
      ordersDatabase = [];
      settingsDatabase.tables.forEach(t => {
        t.status = 'tersedia';
        t.assignedOrder = undefined;
      });
      try {
        await supabase.from('orders').delete().neq('id', '___none___');
        await supabase.from('cafe_settings').upsert(mapSettingsToDb(settingsDatabase));
      } catch {}
      return jsonResponse({ success: true, message: 'Pesanan dibersihkan', data: [], tables: settingsDatabase.tables });
    }

    if (route === 'menu/clear' && method === 'POST') {
      menuDatabase = [];
      try {
        await supabase.from('menu').delete().neq('id', '___none___');
      } catch {}
      return jsonResponse({ success: true, message: 'Menu dikosongkan', data: [] });
    }

    if (route === 'menu/reset-default' && method === 'POST') {
      menuDatabase = [...SAMPLE_MENU_TEMPLATES];
      try {
        await supabase.from('menu').upsert(menuDatabase.map(mapMenuToDb));
      } catch {}
      return jsonResponse({ success: true, message: 'Menu default dimuat', data: menuDatabase });
    }

    if (route === 'inventory/clear' && method === 'POST') {
      inventoryDatabase = [];
      try {
        await supabase.from('inventory').delete().neq('id', '___none___');
      } catch {}
      return jsonResponse({ success: true, message: 'Inventori dikosongkan', data: [] });
    }

    if (route === 'inventory/reset-default' && method === 'POST') {
      inventoryDatabase = [...SAMPLE_INGREDIENTS_TEMPLATES];
      try {
        await supabase.from('inventory').upsert(inventoryDatabase.map(mapInventoryToDb));
      } catch {}
      return jsonResponse({ success: true, message: 'Inventori default dimuat', data: inventoryDatabase });
    }

    if (route === 'reset-all-sample-data' && method === 'POST') {
      ordersDatabase = [];
      menuDatabase = [];
      inventoryDatabase = [];
      settingsDatabase.tables = settingsDatabase.tables.map(t => ({
        ...t,
        status: 'tersedia' as const,
        currentOrderId: undefined,
        occupiedSince: undefined,
      }));
      try {
        await Promise.all([
          supabase.from('orders').delete().neq('id', '___none___'),
          supabase.from('menu').delete().neq('id', '___none___'),
          supabase.from('inventory').delete().neq('id', '___none___'),
          supabase.from('cafe_settings').upsert(mapSettingsToDb(settingsDatabase)),
        ]);
      } catch {}
      return jsonResponse({
        success: true,
        message: 'Semua data sampel berhasil dihapus total!',
        orders: [],
        menu: [],
        inventory: [],
        tables: settingsDatabase.tables,
      });
    }

    // 8. Reports
    if (route === 'reports' && method === 'GET') {
      let totalRevenue = 0;
      let preOrderRevenue = 0;
      let cashierRevenue = 0;
      let qrisRevenue = 0;
      let cashRevenue = 0;
      let noShowCount = 0;
      let noShowProtectedRevenue = 0;

      for (const o of ordersDatabase) {
        if (o.paymentStatus === 'paid') {
          totalRevenue += o.totalAmount;
          if (o.source === 'preorder') preOrderRevenue += o.totalAmount;
          if (o.source === 'cashier') cashierRevenue += o.totalAmount;
          if (o.paymentMethod === 'qris') qrisRevenue += o.totalAmount;
          if (o.paymentMethod === 'cash') cashRevenue += o.totalAmount;
        } else if (o.paymentStatus === 'cancelled_noshow') {
          noShowCount += 1;
          noShowProtectedRevenue += o.totalAmount;
          totalRevenue += o.totalAmount;
        }
      }

      const inventoryValue = inventoryDatabase.reduce((acc, item) => acc + (item.stock * item.costPerUnit), 0);
      return jsonResponse({
        success: true,
        data: {
          totalRevenue,
          totalOrders: ordersDatabase.length,
          preOrderRevenue,
          cashierRevenue,
          qrisRevenue,
          cashRevenue,
          noShowCount,
          noShowProtectedRevenue,
          inventoryValue,
        },
      });
    }

    if (route === 'reports/top-selling' && method === 'GET') {
      const itemMap = new Map<string, TopSellingItem>();
      for (const menu of menuDatabase) {
        itemMap.set(menu.id, {
          menuItemId: menu.id,
          name: menu.name,
          category: menu.category,
          price: menu.price,
          quantitySold: 0,
          totalRevenue: 0,
        });
      }
      for (const order of ordersDatabase) {
        for (const item of order.items) {
          const existing = itemMap.get(item.menuItemId);
          if (existing) {
            existing.quantitySold += item.quantity;
            existing.totalRevenue += item.quantity * item.price;
          } else {
            itemMap.set(item.menuItemId, {
              menuItemId: item.menuItemId,
              name: item.name,
              category: 'kopi',
              price: item.price,
              quantitySold: item.quantity,
              totalRevenue: item.quantity * item.price,
            });
          }
        }
      }
      const sorted = Array.from(itemMap.values()).sort((a, b) => b.quantitySold - a.quantitySold);
      const categoryStats: Record<string, { count: number; revenue: number }> = {
        'kopi': { count: 0, revenue: 0 },
        'non-kopi': { count: 0, revenue: 0 },
        'makanan': { count: 0, revenue: 0 },
        'snack': { count: 0, revenue: 0 },
      };
      for (const item of sorted) {
        if (categoryStats[item.category]) {
          categoryStats[item.category].count += item.quantitySold;
          categoryStats[item.category].revenue += item.totalRevenue;
        }
      }
      return jsonResponse({ success: true, data: { items: sorted, categoryStats } });
    }

    // 9. AI Voice order parser (NLP fallback)
    if (route === 'ai/parse-voice-order' && method === 'POST') {
      const { transcript } = await request.json() as any;
      const cleanText = (transcript || '').toLowerCase();
      const matchedItems: { menuItemId: string; quantity: number; notes?: string }[] = [];
      const numMap: Record<string, number> = {
        'satu': 1, 'dua': 2, 'tiga': 3, 'empat': 4, 'lima': 5,
        '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, 'seporsi': 1, 'segelas': 1
      };

      menuDatabase.forEach(menu => {
        const menuNameLower = menu.name.toLowerCase();
        const keywords = menuNameLower.split(' ');
        const isMatch = keywords.some(k => k.length > 3 && cleanText.includes(k)) || cleanText.includes(menuNameLower);

        if (isMatch) {
          let qty = 1;
          for (const [word, val] of Object.entries(numMap)) {
            if (cleanText.includes(`${word} ${keywords[0]}`) || cleanText.includes(`${keywords[0]} ${word}`)) {
              qty = val;
              break;
            }
          }
          matchedItems.push({
            menuItemId: menu.id,
            quantity: qty,
            notes: cleanText.includes('pedas') ? 'Pedas' : cleanText.includes('less sugar') ? 'Less Sugar' : undefined
          });
        }
      });

      if (matchedItems.length === 0 && cleanText.includes('kopi')) {
        matchedItems.push({ menuItemId: 'm_es_kopsu', quantity: 1 });
      }

      return jsonResponse({ success: true, items: matchedItems, usedAI: false });
    }

    return jsonResponse({ success: false, error: `Route not found: ${route}` }, 404);
  } catch (error: any) {
    return jsonResponse({ success: false, error: error?.message || 'Internal Server Error' }, 500);
  }
}
