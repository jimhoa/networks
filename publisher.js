export async function publishPost({author, text, token, version}, fetcher = fetch) {
  if (!/^urn:li:(person|organization):[A-Za-z0-9_-]+$/.test(author)) throw new Error('Compte LinkedIn invalide');
  if (!text.trim() || text.length > 3000) throw new Error('Le texte doit contenir entre 1 et 3000 caractères');
  if (!token || !/^\d{6}$/.test(version || '')) throw new Error('Connexion ou version API manquante');
  const response = await fetcher('https://api.linkedin.com/rest/posts', {
    method:'POST', signal:AbortSignal.timeout(30000),
    headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json', 'LinkedIn-Version':version, 'X-Restli-Protocol-Version':'2.0.0'},
    body:JSON.stringify({author, commentary:text, visibility:'PUBLIC', distribution:{feedDistribution:'MAIN_FEED',targetEntities:[],thirdPartyDistributionChannels:[]}, lifecycleState:'PUBLISHED', isReshareDisabledByAuthor:false})
  });
  if (!response.ok) throw new Error(`LinkedIn a répondu HTTP ${response.status}. Vérifiez les autorisations avant toute nouvelle tentative.`);
  return response.headers.get('x-restli-id') || 'accepted';
}
