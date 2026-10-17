import { describe, expect, it } from "vitest";
import { parseSinopacCardData } from "../../../src/sources/sinopac/connector";

const summary = [
  {
    Header: "SUCCESS",
    CreditSum: [
      { DataText: "卡號", DataValue: "****1234" },
      { DataText: "永久信用額度", DataValue: "200,000" },
      { DataText: "剩餘可用額度", DataValue: "168,500" },
    ],
  },
];

describe("永豐信用卡帳單金額與狀態解析", () => {
  it("以最新帳務資訊解析台幣／外幣帳單金額、最低應繳與期限", () => {
    const result = parseSinopacCardData(
      {
        summary,
        bills: [],
        accountingInfo: {
          Result: {
            BaseData: { STMTDATE: "20260723", DUEDATE: "20260807" },
            BillAmounts: [
              {
                CurrencyCode: "000",
                CURRBAL: "12,345",
                DUEAMT: "1,234",
                TotalPaymentAmt: "2,000",
              },
              {
                CurrencyCode: "840",
                CURRBAL: "250.50",
                DUEAMT: "25.50",
                TotalPaymentAmt: "250.50",
              },
            ],
          },
        },
      },
      new Date("2026-07-25T00:00:00Z"),
    );

    expect(result.creditCardBills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "credit:sinopac:main",
          currency: "TWD",
          statementAmount: 12_345,
          minimumPayment: 1_234,
          paidAmount: 2_000,
          isPaid: false,
          paymentDueDate: "2026-08-07",
          statementClosingDate: "2026-07-23",
        }),
        expect.objectContaining({
          accountId: "credit:sinopac:main:USD",
          currency: "USD",
          statementAmount: 250.5,
          minimumPayment: 25.5,
          paidAmount: 250.5,
          isPaid: true,
          paymentDueDate: "2026-08-07",
          statementClosingDate: "2026-07-23",
        }),
      ]),
    );
  });

  it.each([
    { paymentValue: "-", paidAmount: 0, isPaid: false },
    { paymentValue: undefined, paidAmount: undefined, isPaid: undefined },
  ])(
    "把永豐外幣累計繳款 $paymentValue 解析為正確狀態",
    ({ paymentValue, paidAmount, isPaid }) => {
      const usdRow: Record<string, string> = {
        CurrencyCode: "840",
        CURRBAL: "250.50",
        DUEAMT: "25.50",
      };
      if (paymentValue !== undefined) usdRow.TotalPaymentAmt = paymentValue;

      const result = parseSinopacCardData({
        summary,
        bills: [],
        accountingInfo: {
          Result: {
            BaseData: { STMTDATE: "20260723", DUEDATE: "20260807" },
            BillAmounts: [
              {
                CurrencyCode: "000",
                CURRBAL: "12,345",
                DUEAMT: "1,234",
                TotalPaymentAmt: "-",
              },
              usdRow,
            ],
          },
        },
      });

      expect(result.creditCardBills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: "credit:sinopac:main",
            currency: "TWD",
            paidAmount: 0,
            isPaid: false,
          }),
          expect.objectContaining({
            accountId: "credit:sinopac:main:USD",
            currency: "USD",
            statementAmount: 250.5,
            minimumPayment: 25.5,
            paidAmount,
            isPaid,
          }),
        ]),
      );
    },
  );
});
