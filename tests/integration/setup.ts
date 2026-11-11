// Интеграционните тестове използват ОТДЕЛНА база (gce_test) – никога основната.
const url = process.env.TEST_DATABASE_URL ?? 'postgresql://gce:gce_dev_password@localhost:5433/gce_test';
if (!url.includes('test')) throw new Error('TEST_DATABASE_URL трябва да сочи към тестова база');
process.env.DATABASE_URL = url;
process.env.NODE_ENV = 'test';
