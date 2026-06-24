jest.mock("../src/services/sms-service", () => ({
    smsService: { send: jest.fn().mockResolvedValue(true) },
}));

jest.mock("../src/services/whatsapp-service", () => ({
    whatsappService: { send: jest.fn().mockResolvedValue(true) },
}));

// Self-contained mock chain — jest.mock factories are hoisted, so nothing
// outside the factory can be referenced here.
jest.mock("../src/db/client", () => {
    const chain: any = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        ilike: jest.fn().mockReturnThis(),
        range: jest.fn(),
        update: jest.fn().mockReturnThis(),
    };
    return {
        supabase: { from: jest.fn().mockReturnValue(chain) },
        dbConfig: { isSupabaseOffline: false },
    };
});

import { supabase } from "../src/db/client";
import { smsService } from "../src/services/sms-service";
import { broadcastDistrictAlerts } from "../src/cron/alert-broadcaster";

const mockedSupabase = supabase as jest.Mocked<typeof supabase>;

function getChain() {
    return mockedSupabase.from() as any;
}

describe("broadcastDistrictAlerts", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("marks the alert as broadcasted before paginating subscribers (not after)", async () => {
        const callOrder: string[] = [];
        const chain = getChain();

        chain.select.mockReturnThis();
        chain.eq.mockReturnThis();
        chain.ilike.mockReturnThis();

        // First select(...).eq(...).eq(...) call: fetch unbroadcasted alerts
        let selectCallCount = 0;
        (mockedSupabase.from as jest.Mock).mockImplementation((table: string) => {
            if (table === "district_alerts") {
                return {
                    select: jest.fn().mockImplementation(() => ({
                        eq: jest.fn().mockImplementation(() => ({
                            eq: jest.fn().mockResolvedValue({
                                data: [
                                    {
                                        id: "alert-1",
                                        district: "Delhi",
                                        medicine_name: "Aspirin 500mg",
                                        alert_level: "medium",
                                        is_active: true,
                                        broadcasted: false,
                                    },
                                ],
                                error: null,
                            }),
                        })),
                    })),
                    update: jest.fn().mockImplementation(() => {
                        callOrder.push("mark_broadcasted");
                        return {
                            eq: jest.fn().mockResolvedValue({ data: null, error: null }),
                        };
                    }),
                };
            }
            if (table === "notification_subscribers") {
                selectCallCount += 1;
                return {
                    select: jest.fn().mockReturnValue({
                        eq: jest.fn().mockReturnValue({
                            ilike: jest.fn().mockReturnValue({
                                range: jest.fn().mockImplementation(() => {
                                    callOrder.push("fetch_subscribers");
                                    return Promise.resolve({ data: [], error: null });
                                }),
                            }),
                        }),
                    }),
                };
            }
            return chain;
        });

        await broadcastDistrictAlerts();

        expect(callOrder[0]).toBe("mark_broadcasted");
        expect(callOrder).toContain("fetch_subscribers");
    });

    it("does not send notifications when marking broadcasted=true fails", async () => {
        (mockedSupabase.from as jest.Mock).mockImplementation((table: string) => {
            if (table === "district_alerts") {
                return {
                    select: jest.fn().mockReturnValue({
                        eq: jest.fn().mockReturnValue({
                            eq: jest.fn().mockResolvedValue({
                                data: [
                                    {
                                        id: "alert-1",
                                        district: "Mumbai",
                                        medicine_name: "Paracetamol",
                                        alert_level: "high",
                                        is_active: true,
                                        broadcasted: false,
                                    },
                                ],
                                error: null,
                            }),
                        }),
                    }),
                    update: jest.fn().mockReturnValue({
                        eq: jest.fn().mockResolvedValue({
                            data: null,
                            error: { message: "DB write failed" },
                        }),
                    }),
                };
            }
            if (table === "notification_subscribers") {
                return {
                    select: jest.fn().mockReturnValue({
                        eq: jest.fn().mockReturnValue({
                            ilike: jest.fn().mockReturnValue({
                                range: jest.fn().mockResolvedValue({
                                    data: [
                                        {
                                            id: "sub-1",
                                            phone: "+911234567890",
                                            language: "en",
                                            channels: ["sms"],
                                            district: "Mumbai",
                                            is_active: true,
                                        },
                                    ],
                                    error: null,
                                }),
                            }),
                        }),
                    }),
                };
            }
            return {};
        });

        await broadcastDistrictAlerts();

        // Subscribers must never be paged/notified once marking the alert
        // as broadcasted has failed — otherwise the alert is silently lost
        // (never re-queued) AND notifications could be sent without a
        // durable broadcasted flag, defeating the dedupe guarantee.
        expect(smsService.send).not.toHaveBeenCalled();
    });

    it("does not re-notify already-broadcasted alerts on the next tick", async () => {
        (mockedSupabase.from as jest.Mock).mockImplementation((table: string) => {
            if (table === "district_alerts") {
                return {
                    select: jest.fn().mockReturnValue({
                        eq: jest.fn().mockReturnValue({
                            // .eq("broadcasted", false) returns no rows because
                            // the alert was already marked broadcasted=true on
                            // a prior tick (even if that tick's send loop
                            // later failed).
                            eq: jest.fn().mockResolvedValue({ data: [], error: null }),
                        }),
                    }),
                };
            }
            return {};
        });

        await broadcastDistrictAlerts();

        expect(smsService.send).not.toHaveBeenCalled();
    });
});