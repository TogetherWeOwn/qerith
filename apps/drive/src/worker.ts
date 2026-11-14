// All traffic stays unavailable until the integration supplies live access checks.
export default {
  fetch(): Response {
    return new Response('Service unavailable', {
      status: 503,
      headers: { 'cache-control': 'no-store' }
    });
  }
};
