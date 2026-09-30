import { type ReactElement, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router';

import { usePmAssistant } from './assistant/pm-assistant.js';

/**
 * Routes `/pm` and `/pm/:conversationId` (NP-197): no longer pages of their own, they are how links (notifications,
 * an issue that is a conversation, older bookmarks) reach the drawer. `/pm` opens its history, `/pm/new` a new
 * conversation, `/pm/:id` that conversation; then the URL goes back to the page the member came from, or to the
 * landing page when the link opened the app.
 */
export default function PmRoute(): ReactElement | null {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const { available, openAssistant } = usePmAssistant();
  const handledRef = useRef(false);

  useEffect(() => {
    if (!available || handledRef.current) return;
    handledRef.current = true;
    if (conversationId === undefined) openAssistant({ view: 'history' });
    else {
      openAssistant({
        view: 'chat',
        conversationId: conversationId === 'new' ? null : conversationId,
      });
    }
    // React Router numbers its history entries: above 0 the member navigated here inside the app.
    const index = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (index > 0) void navigate(-1);
    else void navigate('/', { replace: true });
  }, [available, conversationId, openAssistant, navigate]);

  return null;
}
