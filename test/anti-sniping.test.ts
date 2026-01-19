import { MongoMemoryReplSet } from 'mongodb-memory-server';

let repl: MongoMemoryReplSet;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGO_URI = repl.getUri('auction');
  process.env.NODE_ENV = 'test';
  const { connectMongo } = await import('../src/db/mongoose.js');
  await connectMongo();
});

afterAll(async () => {
  const { disconnectMongo } = await import('../src/db/mongoose.js');
  await disconnectMongo();
  await repl.stop();
});

beforeEach(async () => {
  const mongoose = (await import('mongoose')).default;
  const collections = await mongoose.connection.db.collections();
  for (const c of collections) {
    await c.deleteMany({});
  }
});

test('anti-sniping extends round within limits', async () => {
  const { UserService } = await import('../src/services/user.service.js');
  const { AuctionService } = await import('../src/services/auction.service.js');
  const AuctionModel = (await import('../src/models/auction.model.js')).AuctionModel;

  const u = await UserService.createUser('alice');
  await UserService.topup(u._id.toString(), 10_000);

  const a = await AuctionService.createAuction({
    title: 'a',
    totalItems: 1,
    itemsPerRound: 1,
    roundDurationSec: 10,
    minBidCents: 1,
    antiSnipeWindowSec: 10,
    antiSnipeExtensionSec: 5,
    antiSnipeMaxTotalExtensionSec: 10,
  });

  await AuctionService.startAuction(a._id.toString());
  const before = await AuctionModel.findById(a._id).lean();
  expect(before?.currentRoundExtendedBySec).toBe(0);

  // Place bid immediately; should extend because window is full duration
  await AuctionService.placeBid({ auctionId: a._id.toString(), userId: u._id.toString(), amountCents: 10 });
  const after1 = await AuctionModel.findById(a._id).lean();
  expect(after1?.currentRoundExtendedBySec).toBe(5);

  // Another bid extends but capped to maxTotal=10
  await AuctionService.placeBid({ auctionId: a._id.toString(), userId: u._id.toString(), amountCents: 20 });
  const after2 = await AuctionModel.findById(a._id).lean();
  expect(after2?.currentRoundExtendedBySec).toBe(10);

  // Third bid should not extend further
  await AuctionService.placeBid({ auctionId: a._id.toString(), userId: u._id.toString(), amountCents: 30 });
  const after3 = await AuctionModel.findById(a._id).lean();
  expect(after3?.currentRoundExtendedBySec).toBe(10);
});
