import Link from "next/link";

export default function NotFound() {
  return (
    <main className="plain-page">
      <header className="site-header">
        <Link href="/" className="wordmark">
          Untorn
        </Link>
      </header>
      <h1>Nothing here</h1>
      <p>This page doesn&apos;t exist. Runs and photos are deleted after 24 hours.</p>
      <p>
        <Link href="/" className="btn btn-primary">
          See a page put back together
        </Link>
      </p>
    </main>
  );
}
