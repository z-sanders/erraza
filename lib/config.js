'use strict';

const CURRENCIES = [
  { code: 'usd', label: 'USD', symbol: '$', decimals: 2 },
  { code: 'eur', label: 'EUR', symbol: '€', decimals: 2 },
  { code: 'gbp', label: 'GBP', symbol: '£', decimals: 2 },
  { code: 'cad', label: 'CAD', symbol: 'C$', decimals: 2 },
  { code: 'aud', label: 'AUD', symbol: 'A$', decimals: 2 },
  { code: 'jpy', label: 'JPY', symbol: '¥', decimals: 0 },
  { code: 'chf', label: 'CHF', symbol: 'Fr', decimals: 2 },
  { code: 'sgd', label: 'SGD', symbol: 'S$', decimals: 2 },
  { code: 'ils', label: 'ILS', symbol: '₪', decimals: 2 },
  { code: 'ron', label: 'RON', symbol: 'lei', decimals: 2 },
];
const ONRAMP_CURRENCIES = ['usd', 'eur', 'ils', 'gbp', 'aud', 'ron'];

function getConfig(env = process.env) {
  const deployed = env.VERCEL === '1' || env.NODE_ENV === 'production';
  const sandboxValue = env.NOWPAYMENTS_SANDBOX;
  const sandboxValid = sandboxValue === 'true' || sandboxValue === 'false';
  const sandbox = sandboxValue === 'true';
  const publicUrl = env.PUBLIC_BASE_URL || (!deployed ? `http://localhost:${env.PORT || 3000}` : '');
  let origin = '';
  try {
    const url = new URL(publicUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('origin');
    if (!['http:', 'https:'].includes(url.protocol) || (url.protocol !== 'https:' && (deployed || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('https');
    origin = url.origin;
  } catch { /* Missing or invalid origin leaves checkout disabled. */ }
  const fiatRedirectHosts = (env.NOWPAYMENTS_FIAT_REDIRECT_HOSTS || '').trim()
    ? env.NOWPAYMENTS_FIAT_REDIRECT_HOSTS.split(',').map(value => value.trim().toLowerCase())
    : [];
  const redirectHostsValid = fiatRedirectHosts.every(value => /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value));
  const apiKey = env.NOWPAYMENTS_API_KEY || '';
  const ipnSecret = env.NOWPAYMENTS_IPN_SECRET || '';
  const checkoutSecret = env.CHECKOUT_SECRET || '';
  const supabaseUrl = env.SUPABASE_URL || '';
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || '';
  const supabaseValid = /^https:\/\/[a-z0-9.-]+\.supabase\.co\/?$/i.test(supabaseUrl) && supabaseKey.length >= 40;
  const minAmount = env.MIN_PAYMENT_AMOUNT || '1';
  const maxAmount = env.MAX_PAYMENT_AMOUNT || '100000';
  const boundsValid = /^\d{1,8}(\.\d{1,2})?$/.test(minAmount) && /^\d{1,8}(\.\d{1,2})?$/.test(maxAmount)
    && Number(minAmount) > 0 && Number(maxAmount) >= Number(minAmount);
  const payoutCurrency = (env.NOWPAYMENTS_PAYOUT_CURRENCY || '').trim().toLowerCase();
  const payoutValid = /^[a-z0-9]{2,32}$/.test(payoutCurrency);
  const configured = Boolean(apiKey && ipnSecret && checkoutSecret.length >= 32 && supabaseValid && origin && boundsValid && payoutValid && sandboxValid);
  const supportEmail = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(env.SUPPORT_EMAIL || '') ? env.SUPPORT_EMAIL : null;
  return {
    configured, deployed, vercel: env.VERCEL === '1', sandbox, origin, apiKey, ipnSecret, checkoutSecret, supabaseUrl, supabaseKey, payoutCurrency,
    apiBase: sandbox ? 'https://api-sandbox.nowpayments.io/v1' : 'https://api.nowpayments.io/v1',
    brand: (env.BRAND_NAME || 'Erraza').slice(0, 40), supportEmail,
    minAmount: boundsValid ? minAmount : '1', maxAmount: boundsValid ? maxAmount : '100000',
    fiatEnabled: (env.NOWPAYMENTS_FIAT_ENABLED || 'true') === 'true' && redirectHostsValid,
    fiatRedirectHosts,
    reconciliationSecret: env.RECONCILIATION_SECRET || '',
    currencies: CURRENCIES,
    fiatCurrencies: ONRAMP_CURRENCIES,
    orderTtlSeconds: 60 * 60 * 24 * 90,
    tokenTtlSeconds: 60 * 60 * 24 * 30,
  };
}

module.exports = { getConfig, CURRENCIES, ONRAMP_CURRENCIES };
