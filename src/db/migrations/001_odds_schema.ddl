CREATE TABLE LiveOdds (
    MarketId STRING(MAX) NOT NULL,
    Timestamp TIMESTAMP NOT NULL,
    HomeFair FLOAT64,
    AwayFair FLOAT64,
    DrawFair FLOAT64,
    Overround FLOAT64,
    RawHomeOdds INT64,
    RawAwayOdds INT64,
    DevigMethod STRING(64)
) PRIMARY KEY (MarketId, Timestamp);
