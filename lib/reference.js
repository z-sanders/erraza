'use strict';

const { HttpError } = require('./http');

function paymentReference(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 80
    || /[<>\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(value)) {
    throw new HttpError(400, 'invalid_reference_label', 'Use a name or reference of up to 80 characters, without markup or hidden characters.');
  }
  const normalized = value.normalize('NFC').trim().replace(/ {2,}/g, ' ');
  if (normalized.length > 80) throw new HttpError(400, 'invalid_reference_label', 'Use a name or reference of up to 80 characters.');
  return normalized;
}

// Optional payer email for receipts. Empty means "not provided"; anything
// else must be a plain, single-line address. Stored only when the payer also
// consented, and used only to send that receipt.
function payerEmail(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 254) {
    throw new HttpError(400, 'invalid_payer_email', 'Enter a valid email address or leave it empty.');
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 254
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff<>\s]/.test(normalized)
    || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,63}$/.test(normalized)) {
    throw new HttpError(400, 'invalid_payer_email', 'Enter a valid email address or leave it empty.');
  }
  return normalized;
}

module.exports = { paymentReference, payerEmail };
