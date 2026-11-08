'use strict';

const { HttpError } = require('./http');
const { positiveDecimal, atLeast } = require('./money');

const POPULAR = ['btc', 'eth', 'usdttrc20', 'usdterc20', 'usdc', 'usdcsol', 'sol', 'ltc', 'xrp'];
const NETWORKS = { btc: 'Bitcoin', eth: 'Ethereum', trx: 'TRON', bsc: 'BNB Smart Chain', sol: 'Solana', matic: 'Polygon', xrp: 'XRP Ledger', ltc: 'Litecoin', ton: 'TON', arb: 'Arbitrum', op: 'Optimism', base: 'Base' };

async function assets(provider, store) {
  const cached = await store.getCache('assets');
  if (cached) return cached;
  const [merchant, full] = await Promise.all([provider.merchantCoins(), provider.fullCurrencies()]);
  const selected = Array.isArray(merchant.selectedCurrencies) ? merchant.selectedCurrencies : merchant.currencies;
  if (!Array.isArray(selected) || !Array.isArray(full.currencies)) throw new HttpError(502, 'asset_data_unavailable', 'Payment methods could not be loaded. Please try again.');
  const details = new Map(full.currencies.filter(item => item && typeof item.code === 'string').map(item => [item.code.toLowerCase(), item]));
  const result = selected.filter(code => typeof code === 'string' && /^[a-z0-9]{2,32}$/i.test(code)).map(rawCode => {
    const code = rawCode.toLowerCase();
    const item = details.get(code);
    if (!item || item.enable === false || typeof item.network !== 'string' || !item.network) return null;
    const ticker = code.replace(/^(usdt|usdc)(erc20|trc20|bep20|sol|matic|arb|base|op)$/i, '$1').toUpperCase();
    return { code, ticker, name: String(item.name || ticker).slice(0, 80), network: NETWORKS[item.network.toLowerCase()] || item.network, extraIdRequired: item.extra_id_exists === true };
  }).filter(Boolean);
  result.sort((left, right) => {
    const a = POPULAR.indexOf(left.code), b = POPULAR.indexOf(right.code);
    return (a === -1 ? 999 : a) - (b === -1 ? 999 : b) || left.name.localeCompare(right.name);
  });
  if (!result.length) throw new HttpError(503, 'no_assets', 'The merchant has not enabled any supported crypto payment methods.');
  await store.setCache('assets', result, 120);
  return result;
}

async function quote(amount, currency, asset, provider, store) {
  const key = `quote:${amount}:${currency}:${asset}`;
  const cached = await store.getCache(key);
  if (cached) return cached;
  const [estimate, minimum] = await Promise.all([provider.estimate(amount, currency, asset), provider.minimum(asset, currency)]);
  let estimatedAmount, minFiatAmount;
  try {
    estimatedAmount = positiveDecimal(estimate.estimated_amount);
    minFiatAmount = positiveDecimal(minimum.fiat_equivalent);
  } catch { throw new HttpError(502, 'quote_unavailable', 'The payment quote is unavailable. Please try again.'); }
  if (estimate.currency_from !== currency || estimate.currency_to !== asset) throw new HttpError(502, 'quote_mismatch', 'The payment quote could not be verified.');
  if (!atLeast(amount, minFiatAmount)) throw new HttpError(400, 'below_minimum', `The current minimum for this coin and network is ${minFiatAmount} ${currency.toUpperCase()}. Choose another amount or coin.`);
  const result = { estimatedAmount, minFiatAmount, priceAmount: amount, priceCurrency: currency, payCurrency: asset };
  await store.setCache(key, result, 20);
  return result;
}

module.exports = { assets, quote };
