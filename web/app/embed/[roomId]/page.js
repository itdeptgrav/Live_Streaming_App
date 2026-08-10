import EmbedRoom from "./EmbedRoom";

// Server wrapper. Reading the token here rather than in a client effect keeps
// it available on the very first render — no cascading re-render, and no
// Suspense boundary that useSearchParams() would have forced.
export const metadata = {
  title: "Live session",
  robots: { index: false, follow: false },
};

export default async function EmbedRoomPage({ params, searchParams }) {
  const { roomId } = await params;
  const query = await searchParams;

  return (
    <EmbedRoom
      roomId={roomId}
      token={query?.token || null}
      parentOrigin={query?.parentOrigin || "*"}
    />
  );
}
