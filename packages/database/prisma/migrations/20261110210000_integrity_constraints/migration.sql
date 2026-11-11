-- Ограничения за целостта на икономическите данни (защита на ниво база, независимо от приложния код).
ALTER TABLE "Account" ADD CONSTRAINT "account_balance_nonneg" CHECK ("allowNegative" OR "balance" >= 0);
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "ledger_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "Inventory" ADD CONSTRAINT "inventory_nonneg" CHECK ("quantity" >= 0 AND "reserved" >= 0);
ALTER TABLE "Shareholding" ADD CONSTRAINT "shareholding_valid" CHECK ("shares" >= 0 AND "reserved" >= 0 AND "reserved" <= "shares");
ALTER TABLE "MarketOrder" ADD CONSTRAINT "order_valid" CHECK ("remaining" >= 0 AND "remaining" <= "quantity" AND "escrow" >= 0 AND "price" > 0);
ALTER TABLE "Loan" ADD CONSTRAINT "loan_valid" CHECK ("outstanding" >= 0 AND "principal" > 0);
ALTER TABLE "Company" ADD CONSTRAINT "company_shares_positive" CHECK ("totalShares" > 0);
