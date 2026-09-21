/**
 * Must be imported before `AppModule`. Nest validates the environment while the
 * module graph is loaded, so assigning DEMO_STAND in `before()` is too late.
 */
process.env.DEMO_STAND = 'true';
