-- Трасето на магистралата между градовете, начертано от кмета
ALTER TABLE "CityLink" ADD COLUMN "path" JSONB NOT NULL DEFAULT '[]';
