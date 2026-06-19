import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

async function main() {
  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: 'gen-lang-client-0281999829',
    });
  }

  const db = getFirestore(admin.app(), 'ai-studio-73e9ce7f-7347-4837-a758-ccae784691f2');

  console.log('Fetching users...');
  const usersSnap = await db.collection('users').get();
  console.log(`Found ${usersSnap.size} users.`);

  let deletedCount = 0;
  let updatedCount = 0;

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const convsRef = db.collection('users').doc(uid).collection('conversations');
    const convsSnap = await convsRef.get();

    for (const convDoc of convsSnap.docs) {
      const convData = convDoc.data();
      const turnsRef = convsRef.doc(convDoc.id).collection('turns');
      const turnsSnap = await turnsRef.orderBy('createdAt', 'asc').get();

      if (turnsSnap.empty) {
        // Delete conversation if it has no turns
        console.log(`Deleting blank conversation: ${convDoc.id} for user ${uid}`);
        await convDoc.ref.delete();
        deletedCount++;
      } else {
        // Update title if it's missing or default
        if (!convData.title || convData.title === 'New Conversation' || convData.title.trim() === '') {
          const firstTurn = turnsSnap.docs[0].data();
          const prompt = firstTurn.prompt || 'Untitled Conversation';
          let newTitle = prompt.substring(0, 40);
          if (prompt.length > 40) {
            newTitle += '...';
          }
          console.log(`Updating title for conversation ${convDoc.id} to "${newTitle}"`);
          await convDoc.ref.update({ title: newTitle });
          updatedCount++;
        }
      }
    }
  }

  console.log(`Done. Deleted ${deletedCount} blank conversations. Updated ${updatedCount} titles.`);
}

main().catch(console.error);
