CREATE TABLE `shop.sales.orders` (
  order_id STRING NOT NULL OPTIONS(description="Primary identifier of the order"),
  placed_at TIMESTAMP NOT NULL OPTIONS(description="When the order was placed"),
  total NUMERIC(12, 2) OPTIONS(description="Order total in the shop currency"),
  items ARRAY<STRUCT<sku STRING, qty INT64>> OPTIONS(description="Line items"),
  shipping STRUCT<street STRING, city STRING>,
  tags ARRAY<STRING>
);
