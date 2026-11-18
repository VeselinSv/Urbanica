-- Решения на ръководството на компанията (заплати, поддръжка, автоматични продажби)
ALTER TABLE "Company" ADD COLUMN "policy" JSONB NOT NULL DEFAULT '{}';
