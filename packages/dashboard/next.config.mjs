/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dashboard polls the daemon's HTTP API on a different port.
  // Default to localhost:3000; override via SYMPHONY_DAEMON_URL.
  env: {
    SYMPHONY_DAEMON_URL: process.env.SYMPHONY_DAEMON_URL ?? 'http://127.0.0.1:3000',
  },
};

export default nextConfig;
