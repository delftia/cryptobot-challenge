import { MongoMemoryReplSet } from 'mongodb-memory-server';
let repl;
beforeAll(async () => {
    repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    // getUri from MongoMemoryReplSet already includes replica set params.
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
test('money invariants: reserve delta, charge winners, refund losers at end', async () => {
    const { UserService } = await import('../src/services/user.service.js');
    const { AuctionService } = await import('../src/services/auction.service.js');
    const u1 = await UserService.createUser('alice');
    const u2 = await UserService.createUser('bob');
    await UserService.topup(u1._id.toString(), 10_000);
    await UserService.topup(u2._id.toString(), 10_000);
    const auction = await AuctionService.createAuction({
        title: 't',
        totalItems: 2,
        itemsPerRound: 1,
        roundDurationSec: 10,
        minBidCents: 1,
        antiSnipeWindowSec: 0,
        antiSnipeExtensionSec: 0,
        antiSnipeMaxTotalExtensionSec: 0,
    });
    await AuctionService.startAuction(auction._id.toString());
    await AuctionService.placeBid({ auctionId: auction._id.toString(), userId: u1._id.toString(), amountCents: 100, entryId: 'e1' });
    await AuctionService.placeBid({ auctionId: auction._id.toString(), userId: u2._id.toString(), amountCents: 50, entryId: 'e2' });
    // settle round 1 => alice wins
    await AuctionService.settleRound(auction._id.toString(), new Date(Date.now() + 60_000));
    const UserModel = (await import('../src/models/user.model.js')).UserModel;
    const AuctionModel = (await import('../src/models/auction.model.js')).AuctionModel;
    const BidModel = (await import('../src/models/bid.model.js')).BidModel;
    const WinnerModel = (await import('../src/models/winner.model.js')).WinnerModel;
    const a1 = await AuctionModel.findById(auction._id).lean();
    expect(a1?.currentRound).toBe(2);
    const w = await WinnerModel.find({ auctionId: auction._id }).lean();
    expect(w).toHaveLength(1);
    expect(w[0]?.giftNumber).toBe(1);
    const bActive = await BidModel.find({ auctionId: auction._id, active: true }).lean();
    expect(bActive).toHaveLength(1);
    expect(bActive[0]?.userId.toString()).toBe(u2._id.toString());
    const aliceAfter = await UserModel.findById(u1._id).lean();
    const bobAfter = await UserModel.findById(u2._id).lean();
    // Alice reserved decreased by 100 (charged). Bob still has 50 reserved.
    expect(aliceAfter?.wallet.reservedCents).toBe(0);
    expect(bobAfter?.wallet.reservedCents).toBe(50);
    // Round 2: bob wins second item
    await AuctionService.settleRound(auction._id.toString(), new Date(Date.now() + 120_000));
    const aEnd = await AuctionModel.findById(auction._id).lean();
    expect(aEnd?.status).toBe('ended');
    const bobEnd = await UserModel.findById(u2._id).lean();
    expect(bobEnd?.wallet.reservedCents).toBe(0);
    // No active bids
    const bEnd = await BidModel.find({ auctionId: auction._id, active: true }).lean();
    expect(bEnd).toHaveLength(0);
});
//# sourceMappingURL=auction.e2e.test.js.map