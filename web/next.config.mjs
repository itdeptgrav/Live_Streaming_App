/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      // The docs used to live inside the dashboard, behind the login guard.
      // They are public now. This has to be a config-level redirect: a page
      // under /dashboard would be intercepted by that layout's client-side
      // auth check and bounced to /login before it could redirect anywhere.
      {
        source: "/dashboard/docs",
        destination: "/docs",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
