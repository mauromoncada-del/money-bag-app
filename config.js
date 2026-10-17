// Configuracion publica de la app. La clave "publishable" de Supabase es
// publica por diseño: los datos estan protegidos por login + RLS (solo el
// correo del dueño puede leerlos). Este repo no contiene datos de la cuenta.
window.MB_CONFIG = {
  supabaseUrl: "https://lvxscqkyomtxvdnwqbnb.supabase.co",
  supabaseKey: "sb_publishable_HGcZfwHkBlL7zdDaBFIHSQ_Jhl9G6T6",
  macroSymbols: ["SPY", "QQQ", "^VIX", "^TNX", "DX-Y.NYB", "COP=X", "BTC-USD"],
};
