import { useRouteError, Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The router's error element.
 *
 * Shows what broke without pretending to know why. It deliberately does NOT render
 * the stack: this app is presented on a projector, and a stack trace on screen is
 * both unreadable to the audience and a disclosure of internals.
 */
export function ErrorBoundaryPage() {
  const error = useRouteError();
  const message =
    error?.statusText || error?.message || 'The page could not be rendered.';

  return (
    <div className="container flex min-h-[60vh] items-center justify-center py-16">
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Something went wrong on this screen</CardTitle>
          <CardDescription>
            The rest of the application is unaffected, and nothing was submitted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{String(message)}</p>
          <div className="flex gap-2">
            <Button asChild>
              <Link to="/">Back to the start</Link>
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
