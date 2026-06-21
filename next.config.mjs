/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    "/api/**/*": ["./data/chargebi.sqlite"]
  }
};

export default nextConfig;
