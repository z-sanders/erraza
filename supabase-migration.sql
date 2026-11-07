-- Migration for Erraza: Create orders table in Supabase
-- Run this in your Supabase SQL Editor

-- Create the erraza_orders table
CREATE TABLE IF NOT EXISTS erraza_orders (
  id TEXT PRIMARY KEY,
  data JSONB,
  count INTEGER,  -- for rate limiting
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for expiration cleanup (optional, for maintenance)
CREATE INDEX IF NOT EXISTS idx_erraza_orders_expires_at ON erraza_orders(expires_at);

-- Function to clean up expired records (run periodically via cron or manually)
-- Example: SELECT cleanup_erraza_orders();
