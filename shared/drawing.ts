/** Design completed, including customer confirmation / release follow-up. */
export const isDesignComplete = (status: string) => ['DRAWN', 'CUSTOMER_PENDING', 'DONE'].includes(status)
