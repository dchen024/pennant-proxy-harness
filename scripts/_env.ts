// Loads .env for tsx scripts (Next.js loads it on its own for the app).
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file: rely on the real environment
}
