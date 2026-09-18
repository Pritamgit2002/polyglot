/** @type {import('next').NextConfig} */
const nextConfig = {
  // The web app talks to the API over HTTP only. It deliberately does NOT
  // import the provider packages: keeping the browser bundle free of adapter
  // code is what guarantees no API key can ever be shipped to a client.
  reactStrictMode: true,
};

export default nextConfig;
