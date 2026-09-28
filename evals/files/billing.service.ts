// 架空の課金サービス（評価用）。Stripe を使う月額課金。
import Stripe from 'stripe';
import { prisma } from './prisma';
import { addMonths } from './date';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const FREE_PROJECT_LIMIT = 2;
const PRICE_JPY = 2200;

export async function assertCanCreateProject(orgId: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  if (org.planCode !== 'free') return;
  const count = await prisma.project.count({ where: { organizationId: orgId } });
  if (count >= FREE_PROJECT_LIMIT) throw new Error('free_limit_exceeded');
}

export async function createProject(orgId: string, name: string) {
  await assertCanCreateProject(orgId);
  return prisma.project.create({ data: { organizationId: orgId, name } });
}

export async function subscribe(orgId: string, paymentMethodId: string) {
  const profile = await prisma.billingProfile.findUniqueOrThrow({ where: { organizationId: orgId } });
  const now = new Date();
  const sub = await prisma.subscription.create({
    data: {
      organizationId: orgId,
      planCode: 'pro',
      priceJpy: PRICE_JPY,
      anchorDay: now.getDate(),
      currentPeriodStart: now,
      currentPeriodEnd: addMonths(now, 1),
      status: 'pending_payment',
    },
  });
  const attempt = await prisma.billingAttempt.create({
    data: { subscriptionId: sub.id, periodStart: now, amountJpy: PRICE_JPY, status: 'charging' },
  });
  try {
    const pi = await stripe.paymentIntents.create({
      amount: PRICE_JPY,
      currency: 'jpy',
      customer: profile.stripeCustomerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
    });
    await prisma.$transaction([
      prisma.billingAttempt.update({ where: { id: attempt.id }, data: { status: 'succeeded', stripePaymentIntentId: pi.id } }),
      prisma.subscription.update({ where: { id: sub.id }, data: { status: 'active' } }),
      prisma.organization.update({ where: { id: orgId }, data: { planCode: 'pro' } }),
    ]);
    return sub;
  } catch {
    await prisma.billingAttempt.update({ where: { id: attempt.id }, data: { status: 'failed', failureMessage: null } });
    throw new Error('card_declined');
  }
}

export async function runMonthlyCycle(today = new Date()) {
  const due = await prisma.subscription.findMany({
    where: { status: 'active', currentPeriodEnd: { lte: today } },
    include: { organization: { include: { billingProfile: true } } },
  });
  for (const sub of due) {
    const attempt = await prisma.billingAttempt.create({
      data: { subscriptionId: sub.id, periodStart: sub.currentPeriodEnd, amountJpy: sub.priceJpy, status: 'charging' },
    });
    try {
      const pi = await stripe.paymentIntents.create({
        amount: sub.priceJpy,
        currency: 'jpy',
        customer: sub.organization.billingProfile!.stripeCustomerId,
        off_session: true,
        confirm: true,
      });
      const nextEnd = new Date(sub.currentPeriodEnd);
      nextEnd.setMonth(nextEnd.getMonth() + 1);
      await prisma.$transaction([
        prisma.billingAttempt.update({ where: { id: attempt.id }, data: { status: 'succeeded', stripePaymentIntentId: pi.id } }),
        prisma.subscription.update({ where: { id: sub.id }, data: { currentPeriodStart: sub.currentPeriodEnd, currentPeriodEnd: nextEnd } }),
      ]);
    } catch (e) {
      await prisma.billingAttempt.update({ where: { id: attempt.id }, data: { status: 'failed' } });
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'past_due', pastDueSince: today } });
    }
  }
}

export async function cancel(orgId: string) {
  await prisma.subscription.updateMany({ where: { organizationId: orgId, status: 'active' }, data: { cancelAtPeriodEnd: true } });
}

export async function handleWebhook(rawBody: string, signature: string) {
  const event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET!);
  try {
    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object as Stripe.PaymentIntent;
      await prisma.billingAttempt.updateMany({ where: { stripePaymentIntentId: pi.id }, data: { status: 'failed' } });
    }
    if (event.type === 'charge.refunded') {
      // TODO
    }
    await prisma.webhookEvent.create({ data: { id: event.id, type: event.type, processed: true } });
  } catch {
    // 失敗しても Stripe には 200 を返す（再送で二重処理を避けるため）
  }
  return { received: true };
}
