// Runs in every test worker BEFORE modules are imported.
process.env.NODE_ENV = 'test';
process.env.AUTH_EVENTS = 'off'; // no RabbitMQ in tests; events are captured by a recording bus
process.env.BASELINE_RATE_LIMIT_PER_MINUTE = '1000000';
