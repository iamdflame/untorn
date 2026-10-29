import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page">
      <header className="page-rail">
        <Link className="mark" href="/" aria-label="Untorn, home">
          Un<span className="bar" aria-hidden="true" />
          torn
        </Link>
        <nav aria-label="Site">
          <Link href="/#tear">Tear your own</Link>
          <Link href="/accuracy">Accuracy</Link>
        </nav>
      </header>
      <div className="page-body nf">
        <h1>Nothing here</h1>
        <p>This page doesn&apos;t exist. Runs and photos are deleted after 24 hours.</p>
        <p>
          <Link href="/" className="cta tab">
            <span>See a page put back together</span>
          </Link>
        </p>
      </div>
    </main>
  );
}
