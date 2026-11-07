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

module.exports = { paymentReference };
