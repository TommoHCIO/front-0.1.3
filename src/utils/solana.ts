import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import { SOLANA_CONSTANTS } from './constants';

interface CacheEntry {
  amount: number;
  timestamp: number;
}

const stakedAmountCache = new Map<string, CacheEntry>();

export async function getUserStakedAmount(connection: Connection, walletAddress: string): Promise<number> {
  const now = Date.now();
  
  // Clean up old cache entries
  for (const [key, entry] of stakedAmountCache.entries()) {
    if (now - entry.timestamp > SOLANA_CONSTANTS.CACHE_DURATION) {
      stakedAmountCache.delete(key);
    }
  }

  // Check cache first
  const cached = stakedAmountCache.get(walletAddress);
  if (cached && (now - cached.timestamp) < SOLANA_CONSTANTS.CACHE_DURATION) {
    return cached.amount;
  }

  try {
    const walletPubkey = new PublicKey(walletAddress);
    
    // Get recent signatures for the incubator wallet
    const signatures = await connection.getSignaturesForAddress(
      SOLANA_CONSTANTS.INCUBATOR_WALLET,
      { limit: 1000 },
      'confirmed'
    );

    let total = 0;
    const processedTxs = new Set<string>();

    // Process in smaller batches
    const batchSize = 10;
    for (let i = 0; i < signatures.length; i += batchSize) {
      const batch = signatures.slice(i, i + batchSize);
      
      const transactions = await Promise.all(
        batch.map(({ signature }) =>
          connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
          })
        )
      );

      for (const tx of transactions) {
        if (!tx?.meta || processedTxs.has(tx.signature)) continue;
        processedTxs.add(tx.signature);

        // Check if this transaction involves the user's wallet
        const isFromUser = tx.transaction.message.accountKeys.some(
          key => key.pubkey.toString() === walletAddress
        );

        if (isFromUser) {
          const postBalances = tx.meta.postTokenBalances || [];
          const preBalances = tx.meta.preTokenBalances || [];

          // Look for USDT transfers to the incubator wallet
          for (const post of postBalances) {
            if (post.owner === SOLANA_CONSTANTS.INCUBATOR_WALLET.toString() &&
                post.mint === SOLANA_CONSTANTS.USDT_MINT.toString()) {
              
              const pre = preBalances.find(b => b.accountIndex === post.accountIndex);
              const preAmount = pre?.uiTokenAmount.uiAmount || 0;
              const postAmount = post.uiTokenAmount.uiAmount || 0;
              
              if (postAmount > preAmount) {
                total += (postAmount - preAmount);
              }
            }
          }
        }
      }
    }

    // Cache the result
    stakedAmountCache.set(walletAddress, {
      amount: total,
      timestamp: now
    });

    return total;
  } catch (error) {
    console.error('Failed to fetch staked amount:', error);
    
    // Return cached value if available, even if expired
    const cached = stakedAmountCache.get(walletAddress);
    if (cached) {
      return cached.amount;
    }
    
    throw error;
  }
}